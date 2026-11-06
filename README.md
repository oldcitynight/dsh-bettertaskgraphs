# dsh-bettertaskgraphs

DeepSeek Harness 的事务型任务图 Bundle，包含模型侧的任务图工具和会话输入区的任务图面板。支持嵌套容器、条件分支、单一活动叶节点，以及基于 DSH 会话证据的提交与对账。

面板的事务关系区列出进入条件及对应任务状态。点击「全屏」后，沿连线从左往右阅读。可沿同一条前置链推出的重复条件会合并显示。独立的跨列前置留在目标卡片的进入条件中，并在卡片上标记数量。点击节点可切换所选事务，按 Esc 返回会话。

## 兼容范围

- DSH `0.2.1-rc.5`，使用 Web profile。
- Node.js `^22.19.0 || >=24.0.0`，开发用 npm。此包与 DSH 共享会话、工具和远程调用接口，升级 DSH 时需要重新验证这些接口。

## 构建和打包

```sh
npm ci
npm run build
npm test
npm run pack:bundle
```

`build` 从前端源码生成可由 DSH Web 加载的 `client.js`。`check` 校验生成物与源码一致，`pack:bundle` 会重新构建前端并生成 `dist/dsh-bettertaskgraphs-0.2.2.tgz`。包内包含服务端模块、Web 构建产物、对应源码和构建脚本，以及 Bundle 配置补丁。

## 安装到独立 Web profile

在本仓库目录下运行。以下命令使用名为 `bettertaskgraphs` 的新 profile。DSH 的 `--from-default-profile` 会重置同名 profile，已有该名称时请改用新名字。

```sh
dsh --profile bettertaskgraphs --from-default-profile web --dump-config
dsh plugin --profile bettertaskgraphs add "$PWD/dist/dsh-bettertaskgraphs-0.2.2.tgz"
dsh --profile bettertaskgraphs --dump-config
dsh --profile bettertaskgraphs
```

通过 `--dump-config` 可以确认已合成 `dsh-bettertaskgraphs` 配置层。若同一台机器已运行 Web，请为新 profile 选择一个空闲端口。用 `dsh plugin --profile bettertaskgraphs remove dsh-bettertaskgraphs` 移除该配置层。

## 工作区与已有任务图

Bundle 默认将会话创建时的工作目录作为项目根，账本位于根目录下的 `.dsh/transaction-graphs-v4/`。后续工作目录必须位于该根内，账本路径拒绝符号链接。也可以在 profile 的 `cordis.patch.yml` 中固定项目根。

```yaml
- id: dsh-bettertaskgraphs
  config:
    projectRoot: /absolute/path/to/project
    storageRelative: .dsh/transaction-graphs-v4
    enableSwitch: false
```

替换原有的 `dsh-project-transaction-graph` 时，请在目标 profile 移除旧 Bundle 后再安装此包。两者使用同一组工具和会话投影键。新包沿用 V4 账本与会话事件格式。要接回已有任务图，须使用原会话、相同的项目根和账本目录，并沿用原先的 `enableSwitch` 设置。如果会话从项目子目录启动，请显式指定原项目根。

[DSH 官方 Bundle 打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/docs/user/develop/basic/publish.zh.md)

## 许可证

Copyright (C) 2026 oldcitynight and contributors.

本插件按 GPL-3.0-only 授权。完整条款见 [LICENSE](./LICENSE)。
