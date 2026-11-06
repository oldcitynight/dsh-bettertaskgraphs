# 首次公开发布

首发版本为 `0.2.2`。GitHub 目标为 `oldcitynight/dsh-bettertaskgraphs`，npm 目标为公开包 `dsh-bettertaskgraphs`。GitHub Actions 会检查 Node.js 22 和 24 下的测试及包内容。

## 本地校验

从 `public-release` 分支的干净检出运行以下命令。检查 npm 的文件列表包含 `LICENSE`、`client.source.mjs`、`view-model.mjs` 和 `scripts/build-client.mjs`。首发包的对应源码也可从同名 Git 标签获取。

```sh
npm ci
npm test
npm run pack:bundle
npm publish ./dist/dsh-bettertaskgraphs-0.2.2.tgz --access public --dry-run
```

## 正式发布

确认目标仓库、包名和版本后，先将公开分支推送为 GitHub 的 `main`，再推送同一提交的 `v0.2.2` 标签。首次建仓使用以下命令，且在 npm 发布前确认 GitHub 上的标签和对应源码已经可访问。

```sh
gh repo create oldcitynight/dsh-bettertaskgraphs --public --source . --remote origin
git push origin public-release:main
git push origin refs/tags/v0.2.2
```

使用 npm 发布账户登录，并按 npm 提示完成双重验证。发布上一步验过的同一份安装包。

```sh
npm login --registry https://registry.npmjs.org/
npm publish ./dist/dsh-bettertaskgraphs-0.2.2.tgz --access public
npm view dsh-bettertaskgraphs@0.2.2 version dist.integrity --registry https://registry.npmjs.org/
```

发布后，用独立的 DSH Web profile 从 npm 安装 `dsh-bettertaskgraphs@0.2.2`，确认 Bundle 层和前端面板加载。

[npm 首次发布指南](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
