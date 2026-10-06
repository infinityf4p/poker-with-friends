# Poker Chrome 本地诊断桥

这个桥接器是独立于官方 ChatGPT Chrome 扩展的本地工具。它解决两个问题：

- 官方扩展在当前 API-key 登录模式下会被 ChatGPT OAuth 认证门禁拦截。
- 当前 Chrome 进程没有开放 CDP，Codex 不能直接绑定已有的 Poker 标签页。

API key 只在本机 Node 进程中通过 `OPENAI_API_KEY` 环境变量读取，永远不会发送到浏览器扩展、Poker 页面或 `/snapshot` 响应。扩展只允许在 `poker.infinityf4p.com` 生产站点上运行，并且只采集可见文字、标题、按钮和错误提示；不会读取输入框值、Cookie、localStorage 或密码。

## 启动桥接器

```bash
cd tools/chrome-poker-bridge
node server.mjs
curl http://127.0.0.1:44191/health
```

需要使用 API key 做本地模型诊断时，再在启动前设置：

```bash
OPENAI_API_KEY='你的密钥' OPENAI_BASE_URL='https://api.openai.com/v1' node server.mjs
```

也可使用兼容 OpenAI Responses API 的私有 relay。密钥只存在当前 shell 的环境中。

## 连接当前 Chrome 的 Poker 标签页

1. 打开 `chrome://extensions`，打开右上角“开发者模式”。
2. 选择“加载已解压的扩展程序”，选择本目录的 `extension` 文件夹。
3. 回到 `https://poker.infinityf4p.com/` 标签页，点击扩展图标，再点击“读取当前标签页”。
4. 在终端查看 `curl http://127.0.0.1:44191/snapshot`。

这是唯一需要浏览器侧手动操作的一步，因为 Chrome 不允许外部程序静默安装扩展或接管已有用户配置文件。桥接器不会修改官方扩展、系统 Native Messaging manifest 或 Chrome 用户数据。

## 测试

```bash
node --test test/*.test.mjs
```
