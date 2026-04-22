import { createPublicClient, webSocket, formatEther, formatUnits } from 'viem'
import { mainnet } from 'viem/chains'

// ---------- 配置 ----------
const RPC_WS = 'wss://ethereum-rpc.publicnode.com'

// Chainlink stETH/ETH 喂价合约（Proxy）
const CHAINLINK_STETH_ETH = '0x86392dC19c0b719886221c78AB11eb8Cf5c52812' as const
// Lido 退出队列合约
const LIDO_WITHDRAWAL_QUEUE = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1' as const

// 以太坊协议每天可退出的 ETH（粗略估算，会随协议升级变化）
const DAILY_EXIT_CAPACITY_ETH = 57600

// ---------- ABI ----------
const CHAINLINK_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'aggregator',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'current', type: 'int256' },
      { indexed: true, name: 'roundId', type: 'uint256' },
      { indexed: false, name: 'updatedAt', type: 'uint256' }
    ],
    name: 'AnswerUpdated',
    type: 'event'
  }
] as const

const LIDO_QUEUE_ABI = [
  {
    inputs: [],
    name: 'unfinalizedStETH',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'getLastRequestId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'getLastFinalizedRequestId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'requestId', type: 'uint256' },
      { indexed: true, name: 'requestor', type: 'address' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: false, name: 'amountOfStETH', type: 'uint256' },
      { indexed: false, name: 'amountOfShares', type: 'uint256' }
    ],
    name: 'WithdrawalRequested',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from', type: 'uint256' },
      { indexed: true, name: 'to', type: 'uint256' },
      { indexed: false, name: 'amountOfETHLocked', type: 'uint256' },
      { indexed: false, name: 'sharesToBurn', type: 'uint256' },
      { indexed: false, name: 'timestamp', type: 'uint256' }
    ],
    name: 'WithdrawalsFinalized',
    type: 'event'
  }
] as const

// ---------- Client ----------
const client = createPublicClient({
  chain: mainnet,
  transport: webSocket(RPC_WS, {
    retryCount: 10,
    retryDelay: 2000,
    keepAlive: { interval: 15_000 }
  })
})

// ---------- 状态 ----------
let lastPriceUpdatedAt = 0
let startedAt = Date.now()
let lastBlockTimestamp = 0
let wsEventCount = 0
let blockCount = 0

// ---------- DOM helpers ----------
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

function setConnStatus(state: 'connecting' | 'connected' | 'error', text: string) {
  $('conn-dot').className = 'dot ' + state
  $('conn-text').textContent = text
}

function pulse(elId: string) {
  const el = $(elId)
  el.classList.remove('pulse')
  void el.offsetWidth
  el.classList.add('pulse')
}

// ---------- 业务 ----------
async function fetchPrice() {
  const data = (await client.readContract({
    address: CHAINLINK_STETH_ETH,
    abi: CHAINLINK_ABI,
    functionName: 'latestRoundData'
  })) as readonly [bigint, bigint, bigint, bigint, bigint]

  const [roundId, answer, , updatedAt] = data
  const price = Number(formatUnits(answer, 18))
  const deviation = (price - 1) * 100

  lastPriceUpdatedAt = Number(updatedAt)

  $('price').textContent = price.toFixed(6)
  const dev = $('deviation')
  dev.textContent = `${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`
  dev.className = 'big ' + (
    Math.abs(deviation) < 0.2 ? 'deviation-ok' :
    Math.abs(deviation) < 0.8 ? 'deviation-warn' :
    'deviation-danger'
  )
  $('round-id').textContent = roundId.toString()
  pulse('card-price')
}

async function fetchQueue() {
  const [unfinalized, lastReq, lastFin] = (await Promise.all([
    client.readContract({ address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, functionName: 'unfinalizedStETH' }),
    client.readContract({ address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, functionName: 'getLastRequestId' }),
    client.readContract({ address: LIDO_WITHDRAWAL_QUEUE, abi: LIDO_QUEUE_ABI, functionName: 'getLastFinalizedRequestId' })
  ])) as [bigint, bigint, bigint]

  const unfinalizedEth = Number(formatEther(unfinalized))
  const days = unfinalizedEth / DAILY_EXIT_CAPACITY_ETH
  const pending = lastReq - lastFin

  $('queue-eth').textContent = `${unfinalizedEth.toLocaleString('en-US', { maximumFractionDigits: 0 })} ETH`
  $('queue-days').textContent = days < 1 / 24
    ? '< 1 小时'
    : days < 1
    ? `~${Math.round(days * 24)} 小时`
    : `~${days.toFixed(1)} 天`
  $('last-req').textContent = lastReq.toString()
  $('last-fin').textContent = lastFin.toString()
  $('pending-count').textContent = pending.toString()
  pulse('card-queue')
}

function bumpWsEvents() {
  wsEventCount++
  $('ws-events').textContent = wsEventCount.toString()
}

// ---------- 启动 ----------
async function start() {
  try {
    setConnStatus('connecting', '正在连接 WSS...')

    await Promise.all([fetchPrice(), fetchQueue()])

    setConnStatus('connected', '已连接 · 事件订阅中')

    // 找到 Proxy 背后的实际 aggregator（事件从这里发出）
    const aggregator = (await client.readContract({
      address: CHAINLINK_STETH_ETH,
      abi: CHAINLINK_ABI,
      functionName: 'aggregator'
    })) as `0x${string}`

    // 订阅 Chainlink 价格更新事件
    client.watchContractEvent({
      address: aggregator,
      abi: CHAINLINK_ABI,
      eventName: 'AnswerUpdated',
      onLogs: async () => {
        bumpWsEvents()
        await fetchPrice()
      },
      onError: (e) => console.error('[price watch]', e)
    })

    // 订阅 Lido 队列入队
    client.watchContractEvent({
      address: LIDO_WITHDRAWAL_QUEUE,
      abi: LIDO_QUEUE_ABI,
      eventName: 'WithdrawalRequested',
      onLogs: async () => {
        bumpWsEvents()
        await fetchQueue()
      },
      onError: (e) => console.error('[queue req watch]', e)
    })

    // 订阅 Lido 队列出队
    client.watchContractEvent({
      address: LIDO_WITHDRAWAL_QUEUE,
      abi: LIDO_QUEUE_ABI,
      eventName: 'WithdrawalsFinalized',
      onLogs: async () => {
        bumpWsEvents()
        await fetchQueue()
      },
      onError: (e) => console.error('[queue fin watch]', e)
    })

    // 订阅新区块（保新鲜度 + 作为事件订阅的兜底）
    client.watchBlocks({
      onBlock: (block) => {
        lastBlockTimestamp = Number(block.timestamp)
        $('block-num').textContent = block.number?.toString() ?? '—'
        blockCount++
        // 每 10 个区块（约 2 分钟）兜底刷一次，防止事件订阅静默失败
        if (blockCount % 10 === 0) {
          fetchPrice().catch(console.error)
          fetchQueue().catch(console.error)
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
    setTimeout(start, 5000) // 5 秒后重试
  }
}

// 每秒更新相对时间显示
setInterval(() => {
  if (lastPriceUpdatedAt > 0) $('price-age').textContent = formatAgo(lastPriceUpdatedAt)
  if (lastBlockTimestamp > 0) $('block-time').textContent = formatAgo(lastBlockTimestamp)
  $('uptime').textContent = formatUptime(Date.now() - startedAt)
}, 1000)

start()
