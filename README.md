# stETH 脱锚监控

实时监控 Lido stETH 相对 ETH 的价格偏离和赎回队列时长。

## 数据源

- **价格**：Chainlink `stETH/ETH` 喂价合约 [`0x86392dC19c0b719886221c78AB11eb8Cf5c52812`](https://etherscan.io/address/0x86392dC19c0b719886221c78AB11eb8Cf5c52812)
- **队列**：Lido `WithdrawalQueue` 合约 [`0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1`](https://etherscan.io/address/0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1)
- **RPC**：`wss://ethereum-rpc.publicnode.com`（WebSocket 事件订阅）

## 本地运行

```bash
npm install
npm run dev
```

打开 http://localhost:5173/

## 构建

```bash
npm run build    # 输出到 dist/
```

## 技术栈

- Vite + TypeScript
- viem（WebSocket 订阅 + 合约读取）
- 纯前端，无后端
