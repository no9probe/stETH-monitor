import { createPublicClient, webSocket, formatEther, formatUnits } from 'viem'
import { mainnet } from 'viem/chains'
import type { Address } from 'viem'

// ==================== 配置 ====================
const RPC_WS = 'wss://ethereum-rpc.publicnode.com'
const LIDO_WITHDRAWAL_QUEUE: Address = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1'
const LIDO_QUEUE_API = 'https://wq-api.lido.fi/v1/request-time?amount=1'

type Section = 'featured' | 'lst' | 'stable' | 'btc' | 'general'
type Unit = 'ETH' | 'USD' | 'BTC'

// 非 rebasing LST 的公允价来源：读 token 合约自己的 exchangeRate
// 用来算真正的脱锚：depeg = 市场价 / 公允价 - 1
interface FairValueSource {
  contract: Address
  functionName: 'getExchangeRate' | 'exchangeRate'
  decimals: number
  label: string
}

interface FeedConfig {
  id: string
  section: Section
  label: string
  proxy: Address
  heartbeat: number   // 秒，超过则预言机应推新值
  threshold: number   // 百分比，Chainlink 偏离触发阈值（参考）
  unit: Unit
  // 脱锚参考价（二选一或都不选）：
  // - anchor=1：rebasing LST / 稳定币 / WBTC 这类 1:1 锚定
  // - fairValue：从 token 合约读 exchangeRate（rETH / cbETH 这类非 rebasing LST）
  // - 都为 null：纯价格显示，不算偏离
  anchor: number | null
  fairValue?: FairValueSource
}

interface DerivedConfig {
  id: string
  section: Section
  label: string
  numId: string
  denId: string
  unit: Unit
  anchor: number | null
  threshold: number
}

const FEEDS: FeedConfig[] = [
  { id:'steth-eth',  section:'featured', label:'stETH / ETH',  proxy:'0x86392dC19c0b719886221c78AB11eb8Cf5c52812', heartbeat:86400, threshold:0.5,  unit:'ETH', anchor:1 },
  // rETH / cbETH 是非 rebasing LST，市场价随质押收益累积增长（~1.16、~1.12），读各自合约的 exchangeRate 作公允价参照
  { id:'reth-eth',   section:'lst',      label:'rETH / ETH',   proxy:'0x536218f9E9Eb48863970252233c8F271f554C2d0', heartbeat:86400, threshold:2,    unit:'ETH', anchor:null,
    fairValue:{ contract:'0xae78736Cd615f374D3085123A210448E74Fc6393', functionName:'getExchangeRate', decimals:18, label:'Rocket Pool rETH' } },
  { id:'cbeth-eth',  section:'lst',      label:'cbETH / ETH',  proxy:'0xF017fcB346A1885194689bA23Eff2fE6fA5C483b', heartbeat:86400, threshold:1,    unit:'ETH', anchor:null,
    fairValue:{ contract:'0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', functionName:'exchangeRate',    decimals:18, label:'Coinbase cbETH' } },
  { id:'usdc-usd',   section:'stable',   label:'USDC / USD',   proxy:'0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', heartbeat:82800, threshold:0.25, unit:'USD', anchor:1 },
  { id:'usdt-usd',   section:'stable',   label:'USDT / USD',   proxy:'0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', heartbeat:86400, threshold:0.25, unit:'USD', anchor:1 },
  { id:'dai-usd',    section:'stable',   label:'DAI / USD',    proxy:'0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', heartbeat:3600,  threshold:0.25, unit:'USD', anchor:1 },
  { id:'frax-usd',   section:'stable',   label:'FRAX / USD',   proxy:'0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD', heartbeat:3600,  threshold:1,    unit:'USD', anchor:1 },
  { id:'crvusd-usd', section:'stable',   label:'crvUSD / USD', proxy:'0xEEf0C605546958c1f899b6fB336C20671f9cD49F', heartbeat:86400, threshold:0.5,  unit:'USD', anchor:1 },
  { id:'wbtc-btc',   section:'btc',      label:'WBTC / BTC',   proxy:'0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23', heartbeat:86400, threshold:0.5,  unit:'BTC', anchor:1 },
  { id:'cbbtc-usd',  section:'btc',      label:'cbBTC / USD',  proxy:'0x2665701293fCbEB223D11A08D826563EDcCE423A', heartbeat:86400, threshold:2,    unit:'USD', anchor:null },
  { id:'tbtc-usd',   section:'btc',      label:'tBTC / USD',   proxy:'0x8350b7De6a6a2C1368E7D4Bd968190e13E354297', heartbeat:86400, threshold:2,    unit:'USD', anchor:null },
  { id:'btc-usd',    section:'general',  label:'BTC / USD',    proxy:'0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', heartbeat:3600,  threshold:0.5,  unit:'USD', anchor:null },
  { id:'eth-usd',    section:'general',  label:'ETH / USD',    proxy:'0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', heartbeat:3600,  threshold:0.5,  unit:'USD', anchor:null },
]

// 派生：cbBTC 和 tBTC 没有 /BTC 喂价，用 /USD 除以 BTC/USD 得到隐含比
const DERIVED: DerivedConfig[] = [
  { id:'cbbtc-btc-implied', section:'btc', label:'cbBTC / BTC（隐含）', numId:'cbbtc-usd', denId:'btc-usd', unit:'BTC', anchor:1, threshold:0.5 },
  { id:'tbtc-btc-implied',  section:'btc', label:'tBTC / BTC（隐含）',  numId:'tbtc-usd',  denId:'btc-usd', unit:'BTC', anchor:1, threshold:0.5 },
]

// ==================== ABI ====================
const PROXY_ABI = [
  { inputs:[], name:'description', outputs:[{type:'string'}],  stateMutability:'view', type:'function' },
  { inputs:[], name:'decimals',    outputs:[{type:'uint8'}],   stateMutability:'view', type:'function' },
  { inputs:[], name:'aggregator',  outputs:[{type:'address'}], stateMutability:'view', type:'function' },
  { inputs:[], name:'latestRoundData', outputs:[
    {name:'roundId',type:'uint80'},{name:'answer',type:'int256'},
    {name:'startedAt',type:'uint256'},{name:'updatedAt',type:'uint256'},
    {name:'answeredInRound',type:'uint80'}
  ], stateMutability:'view', type:'function' },
] as const

// 非 rebasing LST 的公允价 ABI：token 合约自己的 exchangeRate
const FAIR_VALUE_ABI = [
  { inputs:[], name:'getExchangeRate', outputs:[{type:'uint256'}], stateMutability:'view', type:'function' },
  { inputs:[], name:'exchangeRate',    outputs:[{type:'uint256'}], stateMutability:'view', type:'function' },
] as const

const AGGREGATOR_ABI = [
  { inputs:[], name:'minAnswer', outputs:[{type:'int192'}], stateMutability:'view', type:'function' },
  { inputs:[], name:'maxAnswer', outputs:[{type:'int192'}], stateMutability:'view', type:'function' },
  { anonymous:false, inputs:[
    { indexed:true,  name:'current',   type:'int256' },
    { indexed:true,  name:'roundId',   type:'uint256' },
    { indexed:false, name:'updatedAt', type:'uint256' }
  ], name:'AnswerUpdated', type:'event' },
] as const

const LIDO_QUEUE_ABI = [
  { inputs:[], name:'unfinalizedStETH',          outputs:[{type:'uint256'}], stateMutability:'view', type:'function' },
  { inputs:[], name:'getLastRequestId',          outputs:[{type:'uint256'}], stateMutability:'view', type:'function' },
  { inputs:[], name:'getLastFinalizedRequestId', outputs:[{type:'uint256'}], stateMutability:'view', type:'function' },
  { anonymous:false, inputs:[
    { indexed:true,  name:'requestId',      type:'uint256' },
    { indexed:true,  name:'requestor',      type:'address' },
    { indexed:true,  name:'owner',          type:'address' },
    { indexed:false, name:'amountOfStETH',  type:'uint256' },
    { indexed:false, name:'amountOfShares', type:'uint256' }
  ], name:'WithdrawalRequested', type:'event' },
  { anonymous:false, inputs:[
    { indexed:true,  name:'from',             type:'uint256' },
    { indexed:true,  name:'to',               type:'uint256' },
    { indexed:false, name:'amountOfETHLocked',type:'uint256' },
    { indexed:false, name:'sharesToBurn',     type:'uint256' },
    { indexed:false, name:'timestamp',        type:'uint256' }
  ], name:'WithdrawalsFinalized', type:'event' },
] as const

// ==================== Client ====================
const client = createPublicClient({
  chain: mainnet,
  transport: webSocket(RPC_WS, {
    retryCount: 10,
    retryDelay: 2000,
    keepAlive: { interval: 15_000 }
  })
})

// ==================== 运行时状态 ====================
interface FeedState {
  config: FeedConfig
  aggregator?: Address
  description?: string
  decimals?: number
  minAnswer?: number
  maxAnswer?: number
  price?: number
  roundId?: bigint
  updatedAt?: number  // unix sec
  fairValue?: number        // 公允价（非 rebasing LST 从 token 合约读 exchangeRate）
  fairValueReadAt?: number  // 公允价上次读取时间（unix sec）
  unwatchPrice?: () => void
  cardEl?: HTMLElement
}

interface DerivedState {
  config: DerivedConfig
  price?: number
  updatedAt?: number
  cardEl?: HTMLElement
}

const feedStates = new Map<string, FeedState>()
const derivedStates = new Map<string, DerivedState>()

const startedAt = Date.now()
let lastBlockTimestamp = 0
let wsEventCount = 0
let blockCount = 0

// ==================== 工具 ====================
const $ = (id: string) => document.getElementById(id) as HTMLElement

function formatAgo(unixSec: number): string {
  const now = Math.floor(Date.now() / 1000)
  const s = Math.max(0, now - unixSec)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function formatHeartbeat(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

function unitSymbol(u: Unit): string {
  return u === 'USD' ? '$' : ''
}

function formatPrice(price: number, unit: Unit, anchor: number | null): string {
  if (anchor === 1) return price.toFixed(6)
  if (unit === 'USD') return price >= 1000 ? price.toFixed(2) : price.toFixed(4)
  return price.toFixed(6)
}

function deviationClass(devAbs: number): string {
  if (devAbs < 0.2) return 'deviation-ok'
  if (devAbs < 0.8) return 'deviation-warn'
  return 'deviation-danger'
}

function shortAddr(a: Address): string {
  return `${a.slice(0, 8)}…${a.slice(-6)}`
}

function setConnStatus(state: 'connecting' | 'connected' | 'error', text: string) {
  $('conn-dot').className = 'dot ' + state
  $('conn-text').textContent = text
}

function pulse(el: HTMLElement) {
  el.classList.remove('pulse')
  void el.offsetWidth
  el.classList.add('pulse')
}

function bumpWsEvents() {
  wsEventCount++
  $('ws-events').textContent = wsEventCount.toString()
}

// ==================== 卡片模板 ====================
function buildFeedCard(cfg: FeedConfig): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card' + (cfg.section === 'featured' ? '' : ' dense')
  card.id = `card-${cfg.id}`
  card.innerHTML = `
    <div class="card-title">
      <span data-k="label">${cfg.label}</span>
      <span class="tag" data-k="status">…</span>
    </div>
    <div class="big loading" data-k="main">—</div>
    <div class="meta">
      ${ cfg.anchor !== null
        ? `<div class="meta-row"><span class="k">市场价</span><span class="v" data-k="price">—</span></div>
           <div class="meta-row"><span class="k">锚定价</span><span class="v">${cfg.anchor}.000000</span></div>`
        : cfg.fairValue
        ? `<div class="meta-row"><span class="k">市场价</span><span class="v" data-k="price">—</span></div>
           <div class="meta-row"><span class="k">公允价</span><span class="v" data-k="fair" title="${cfg.fairValue.label} · ${cfg.fairValue.functionName}()">—</span></div>`
        : `<div class="meta-row"><span class="k">偏离</span><span class="v">—</span></div>` }
      <div class="meta-row"><span class="k">Heartbeat</span><span class="v">${formatHeartbeat(cfg.heartbeat)} · dev阈 ${cfg.threshold}%</span></div>
      <div class="meta-row"><span class="k">Round ID</span><span class="v" data-k="round">—</span></div>
      <div class="meta-row"><span class="k">链上更新于</span><span class="v" data-k="age">—</span></div>
      <div class="meta-row"><span class="k">熔断带</span><span class="v" data-k="range">—</span></div>
      <div class="meta-row"><span class="k">Proxy</span><span class="v" title="${cfg.proxy}">${shortAddr(cfg.proxy)}</span></div>
      <div class="meta-row"><span class="k">Aggregator</span><span class="v" data-k="agg">—</span></div>
    </div>
  `
  return card
}

function buildDerivedCard(cfg: DerivedConfig): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card dense'
  card.id = `card-${cfg.id}`
  card.innerHTML = `
    <div class="card-title">
      <span>${cfg.label}</span>
      <span class="tag">派生</span>
    </div>
    <div class="big loading" data-k="main">—</div>
    <div class="meta">
      <div class="meta-row"><span class="k">比值</span><span class="v" data-k="ratio">—</span></div>
      <div class="meta-row"><span class="k">锚定</span><span class="v">${cfg.anchor ?? '—'}.000000</span></div>
      <div class="meta-row"><span class="k">来源</span><span class="v">${cfg.numId} ÷ ${cfg.denId}</span></div>
      <div class="meta-row"><span class="k">更新于</span><span class="v" data-k="age">—</span></div>
    </div>
  `
  return card
}

function mountCards() {
  // 幂等：清空所有区块容器（防止重入导致 DOM 累积）
  for (const sec of ['lst', 'stable', 'btc', 'general']) {
    const el = document.getElementById(`section-${sec}`)
    if (el) el.innerHTML = ''
  }
  // featured 区特殊：清掉之前 prepend 进来的 stETH 卡（不影响静态的 queue/network）
  const featured = $('featured-grid')
  for (const f of FEEDS.filter(x => x.section === 'featured')) {
    const existing = document.getElementById(`card-${f.id}`)
    if (existing) existing.remove()
  }
  for (const d of DERIVED) {
    const existing = document.getElementById(`card-${d.id}`)
    if (existing) existing.remove()
  }

  for (const cfg of FEEDS) {
    const card = buildFeedCard(cfg)
    feedStates.set(cfg.id, { config: cfg, cardEl: card })
    if (cfg.section === 'featured') {
      featured.prepend(card)
    } else {
      $(`section-${cfg.section}`).appendChild(card)
    }
  }
  for (const cfg of DERIVED) {
    const card = buildDerivedCard(cfg)
    derivedStates.set(cfg.id, { config: cfg, cardEl: card })
    $(`section-${cfg.section}`).appendChild(card)
  }
}

// ==================== 渲染 ====================
function render(id: string) {
  const s = feedStates.get(id)
  if (!s || !s.cardEl) return
  const c = s.config
  const q = (k: string) => s.cardEl!.querySelector(`[data-k="${k}"]`) as HTMLElement | null

  if (s.description) {
    const labelEl = q('label')
    if (labelEl) labelEl.textContent = s.description
  }

  const now = Math.floor(Date.now() / 1000)
  const age = s.updatedAt ? now - s.updatedAt : null
  const stale   = age !== null && age > c.heartbeat * 0.8
  const expired = age !== null && age > c.heartbeat * 1.1

  const statusTag = q('status')
  if (statusTag) {
    if (expired)          { statusTag.textContent = '过期';     statusTag.className = 'tag expired' }
    else if (stale)       { statusTag.textContent = '即将过期'; statusTag.className = 'tag stale' }
    else if (s.updatedAt) { statusTag.textContent = '正常';     statusTag.className = 'tag' }
    else                  { statusTag.textContent = '加载中';   statusTag.className = 'tag' }
  }
  s.cardEl.classList.toggle('stale',   stale && !expired)
  s.cardEl.classList.toggle('expired', expired)

  // 脱锚分母：优先锚定价（1:1），否则公允价（exchangeRate），否则纯价格模式
  const target: number | null =
    c.anchor !== null ? c.anchor :
    c.fairValue && s.fairValue !== undefined ? s.fairValue :
    null

  const main = q('main')
  if (main && s.price !== undefined) {
    main.classList.remove('loading')
    if (target !== null) {
      const dev = (s.price / target - 1) * 100
      main.textContent = `${dev >= 0 ? '+' : ''}${dev.toFixed(3)}%`
      main.className = 'big ' + deviationClass(Math.abs(dev))
    } else {
      main.textContent = `${unitSymbol(c.unit)}${formatPrice(s.price, c.unit, c.anchor)}`
      main.className = 'big'
    }
  }

  if (s.price !== undefined && (c.anchor !== null || c.fairValue)) {
    const priceEl = q('price')
    if (priceEl) priceEl.textContent = formatPrice(s.price, c.unit, 1)
  }
  if (s.fairValue !== undefined) {
    const fairEl = q('fair')
    if (fairEl) fairEl.textContent = s.fairValue.toFixed(6)
  }

  const roundEl = q('round')
  if (roundEl && s.roundId !== undefined) roundEl.textContent = s.roundId.toString()

  const ageEl = q('age')
  if (ageEl && s.updatedAt) ageEl.textContent = formatAgo(s.updatedAt)

  const rangeEl = q('range')
  if (rangeEl) {
    if (s.minAnswer !== undefined && s.maxAnswer !== undefined) {
      const fmt = (v: number) => c.anchor === 1 ? v.toFixed(4) : (v >= 1000 ? v.toFixed(0) : v.toFixed(4))
      rangeEl.textContent = `${fmt(s.minAnswer)} ~ ${fmt(s.maxAnswer)}`
    } else {
      rangeEl.textContent = '—'
    }
  }

  const aggEl = q('agg')
  if (aggEl && s.aggregator) {
    aggEl.textContent = shortAddr(s.aggregator)
    aggEl.setAttribute('title', s.aggregator)
  }
}

function renderDerived(id: string) {
  const s = derivedStates.get(id)
  if (!s || !s.cardEl) return
  const c = s.config
  const q = (k: string) => s.cardEl!.querySelector(`[data-k="${k}"]`) as HTMLElement | null

  const main = q('main')
  if (main && s.price !== undefined) {
    main.classList.remove('loading')
    if (c.anchor !== null) {
      const dev = (s.price / c.anchor - 1) * 100
      main.textContent = `${dev >= 0 ? '+' : ''}${dev.toFixed(3)}%`
      main.className = 'big ' + deviationClass(Math.abs(dev))
    } else {
      main.textContent = s.price.toFixed(6)
      main.className = 'big'
    }
  }

  const ratioEl = q('ratio')
  if (ratioEl && s.price !== undefined) ratioEl.textContent = s.price.toFixed(6)

  const ageEl = q('age')
  if (ageEl && s.updatedAt) ageEl.textContent = formatAgo(s.updatedAt)
}

// ==================== Feed 读取 ====================
async function fetchLatest(id: string) {
  const s = feedStates.get(id)
  if (!s) return
  try {
    const data = await client.readContract({
      address: s.config.proxy,
      abi: PROXY_ABI,
      functionName: 'latestRoundData'
    }) as readonly [bigint, bigint, bigint, bigint, bigint]
    const [roundId, answer, , updatedAt] = data
    const decimals = s.decimals ?? 8
    s.price = Number(formatUnits(answer, decimals))
    s.roundId = roundId
    s.updatedAt = Number(updatedAt)
    // 非 rebasing LST 同步刷新公允价（rETH / cbETH）
    if (s.config.fairValue) await fetchFairValue(id)
    render(id)
    if (s.cardEl) pulse(s.cardEl)
    recomputeDerivedFor(id)
  } catch (e) {
    console.error(`[${id}] fetchLatest`, e)
  }
}

async function fetchFeedMeta(id: string) {
  const s = feedStates.get(id)
  if (!s) return
  const c = s.config
  try {
    const [description, decimals, aggregator] = await Promise.all([
      client.readContract({ address: c.proxy, abi: PROXY_ABI, functionName: 'description' })
        .then(v => v as string).catch(() => c.label),
      client.readContract({ address: c.proxy, abi: PROXY_ABI, functionName: 'decimals' })
        .then(v => v as number),
      client.readContract({ address: c.proxy, abi: PROXY_ABI, functionName: 'aggregator' })
        .then(v => v as Address),
    ])
    s.description = description
    s.decimals = decimals
    s.aggregator = aggregator
    await fetchMinMax(id)
  } catch (e) {
    console.error(`[${id}] fetchFeedMeta`, e)
  }
}

async function fetchFairValue(id: string) {
  const s = feedStates.get(id)
  if (!s?.config.fairValue) return
  const fv = s.config.fairValue
  try {
    const raw = await client.readContract({
      address: fv.contract,
      abi: FAIR_VALUE_ABI,
      functionName: fv.functionName
    }) as bigint
    s.fairValue = Number(formatUnits(raw, fv.decimals))
    s.fairValueReadAt = Math.floor(Date.now() / 1000)
  } catch (e) {
    console.error(`[${id}] fairValue`, e)
  }
}

async function fetchMinMax(id: string) {
  const s = feedStates.get(id)
  if (!s || !s.aggregator || s.decimals === undefined) return
  try {
    const [minA, maxA] = await Promise.all([
      client.readContract({ address: s.aggregator, abi: AGGREGATOR_ABI, functionName: 'minAnswer' }) as Promise<bigint>,
      client.readContract({ address: s.aggregator, abi: AGGREGATOR_ABI, functionName: 'maxAnswer' }) as Promise<bigint>,
    ])
    s.minAnswer = Number(formatUnits(minA, s.decimals))
    s.maxAnswer = Number(formatUnits(maxA, s.decimals))
  } catch {
    // 某些底层 aggregator 不暴露 minAnswer/maxAnswer，忽略
  }
}

function subscribeFeed(id: string) {
  const s = feedStates.get(id)
  if (!s || !s.aggregator) return
  s.unwatchPrice?.()
  s.unwatchPrice = client.watchContractEvent({
    address: s.aggregator,
    abi: AGGREGATOR_ABI,
    eventName: 'AnswerUpdated',
    onLogs: () => {
      bumpWsEvents()
      fetchLatest(id).catch(console.error)
    },
    onError: (e) => console.error(`[${id}] price watch`, e)
  })
}

// 周期性检查 Proxy 背后的 aggregator 是否被替换，被替换则重新订阅
async function ensureAggregatorCurrent(id: string) {
  const s = feedStates.get(id)
  if (!s) return
  try {
    const current = await client.readContract({
      address: s.config.proxy, abi: PROXY_ABI, functionName: 'aggregator'
    }) as Address
    if (s.aggregator && current.toLowerCase() !== s.aggregator.toLowerCase()) {
      console.log(`[${id}] aggregator 切换 ${s.aggregator} → ${current}`)
      s.aggregator = current
      await fetchMinMax(id)
      subscribeFeed(id)
      render(id)
    }
  } catch (e) {
    console.error(`[${id}] ensureAggregatorCurrent`, e)
  }
}

// ==================== 派生 ====================
function recomputeDerivedFor(changedFeedId: string) {
  for (const [id, s] of derivedStates) {
    const c = s.config
    if (c.numId !== changedFeedId && c.denId !== changedFeedId) continue
    const num = feedStates.get(c.numId)
    const den = feedStates.get(c.denId)
    if (!num || !den || num.price === undefined || den.price === undefined || den.price === 0) continue
    s.price = num.price / den.price
    s.updatedAt = Math.min(num.updatedAt ?? 0, den.updatedAt ?? 0)
    renderDerived(id)
    if (s.cardEl) pulse(s.cardEl)
  }
}

// ==================== Lido 队列（原逻辑保留） ====================
type LidoApiQueue = {
  days: number
  requests: number
  steth: string
  stethLastUpdate: number
  validatorsLastUpdate: number
  status: string
}
const LIDO_API_TTL_MS = 60_000
let lidoApiCache: { data: LidoApiQueue; fetchedAt: number } | null = null
let lidoInflight: Promise<LidoApiQueue | null> | null = null

async function fetchLidoApiRaw(): Promise<LidoApiQueue | null> {
  try {
    const resp = await fetch(LIDO_QUEUE_API)
    if (!resp.ok) return null
    const data = (await resp.json()) as LidoApiQueue
    if (data.status !== 'calculated') return null
    return data
  } catch (e) {
    console.error('[lido api]', e)
    return null
  }
}

async function getLidoApi(): Promise<LidoApiQueue | null> {
  if (lidoApiCache && Date.now() - lidoApiCache.fetchedAt < LIDO_API_TTL_MS) return lidoApiCache.data
  if (lidoInflight) return lidoInflight
  lidoInflight = fetchLidoApiRaw().finally(() => { lidoInflight = null })
  const fresh = await lidoInflight
  if (fresh) { lidoApiCache = { data: fresh, fetchedAt: Date.now() }; return fresh }
  return lidoApiCache?.data ?? null
}

async function fetchQueue() {
  const [onchain, api] = await Promise.all([
    Promise.all([
      client.readContract({ address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, functionName: 'unfinalizedStETH' }),
      client.readContract({ address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, functionName: 'getLastRequestId' }),
      client.readContract({ address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, functionName: 'getLastFinalizedRequestId' })
    ]) as Promise<[bigint, bigint, bigint]>,
    getLidoApi()
  ])
  const [unfinalized, lastReq, lastFin] = onchain
  const unfinalizedEth = Number(formatEther(unfinalized))
  const pending = lastReq - lastFin

  $('queue-eth').textContent = `${unfinalizedEth.toLocaleString('en-US', { maximumFractionDigits: 0 })} ETH`
  $('last-req').textContent = lastReq.toString()
  $('last-fin').textContent = lastFin.toString()
  $('pending-count').textContent = pending.toString()

  if (api) {
    $('queue-days').textContent = api.days < 1 ? '< 1 天' : `~${api.days} 天`
    $('queue-source').textContent = `Lido API · 数据于 ${formatAgo(api.stethLastUpdate)}`
  } else {
    const estDays = unfinalizedEth / 108000
    $('queue-days').textContent = `~${estDays.toFixed(1)} 天 (链上粗估)`
    $('queue-source').textContent = 'Lido API 加载中 · 30 秒后重试...'
  }
  pulse($('card-queue'))
}

// ==================== 启动 ====================
// 订阅句柄：重试前先清掉，防止累积
let unwatchBlocks: (() => void) | null = null
let unwatchQueueReq: (() => void) | null = null
let unwatchQueueFin: (() => void) | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function cleanupSubscriptions() {
  unwatchBlocks?.(); unwatchBlocks = null
  unwatchQueueReq?.(); unwatchQueueReq = null
  unwatchQueueFin?.(); unwatchQueueFin = null
  for (const s of feedStates.values()) {
    s.unwatchPrice?.(); s.unwatchPrice = undefined
  }
}

async function connect() {
  // 进入前一律清订阅，避免重试累积
  cleanupSubscriptions()

  try {
    setConnStatus('connecting', '正在连接 WSS...')

    // 批量读元数据 + 首次价格 + 队列
    await Promise.all([
      ...FEEDS.map(f => fetchFeedMeta(f.id)),
      fetchQueue()
    ])
    for (const f of FEEDS) render(f.id)
    await Promise.all(FEEDS.map(f => fetchLatest(f.id)))
    for (const d of DERIVED) renderDerived(d.id)

    setConnStatus('connected', '已连接 · 事件订阅中')

    // 订阅每个喂价的 AnswerUpdated（内部已清旧 unwatch）
    for (const f of FEEDS) subscribeFeed(f.id)

    // Lido 队列订阅
    unwatchQueueReq = client.watchContractEvent({
      address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, eventName: 'WithdrawalRequested',
      onLogs: () => { bumpWsEvents(); fetchQueue().catch(console.error) },
      onError: (e) => console.error('[queue req watch]', e)
    })
    unwatchQueueFin = client.watchContractEvent({
      address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, eventName: 'WithdrawalsFinalized',
      onLogs: () => { bumpWsEvents(); fetchQueue().catch(console.error) },
      onError: (e) => console.error('[queue fin watch]', e)
    })

    // 区块订阅 + 兜底刷新
    unwatchBlocks = client.watchBlocks({
      onBlock: (block) => {
        lastBlockTimestamp = Number(block.timestamp)
        $('block-num').textContent = block.number?.toString() ?? '—'
        blockCount++
        if (blockCount % 10 === 0) {
          fetchQueue().catch(console.error)
          for (const f of FEEDS) fetchLatest(f.id).catch(console.error)
        }
        if (blockCount % 30 === 0) {
          for (const f of FEEDS) ensureAggregatorCurrent(f.id).catch(console.error)
        }
      },
      onError: (e) => {
        console.error('[block watch]', e)
        setConnStatus('error', '区块订阅失败')
      }
    })
  } catch (err) {
    console.error(err)
    setConnStatus('error', `连接失败: ${(err as Error).message}`)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(connect, 5000)
  }
}

// 一次性初始化：DOM 挂载 + 定时器 + 启动连接
mountCards()

// 每秒刷相对时间 / 心跳告警
setInterval(() => {
  for (const id of feedStates.keys()) render(id)
  for (const id of derivedStates.keys()) renderDerived(id)
  if (lastBlockTimestamp > 0) $('block-time').textContent = formatAgo(lastBlockTimestamp)
  $('uptime').textContent = formatUptime(Date.now() - startedAt)
}, 1000)

// 独立 30 秒队列刷新（对抗 Lido API 限流/静默失败）
setInterval(() => { fetchQueue().catch(console.error) }, 30_000)

connect()
