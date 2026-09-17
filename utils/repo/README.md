# 双仓架构：同一工作区、两个 git 目录

| | 打包产物仓（公开） | 源码仓（私有） |
|---|---|---|
| 远端 | `git@github.com:wangyu-ctw/arti-playable.git` | `git@github.com:wangyu-ctw/arti-playable-origin.git` |
| git 目录 | `.git` | `.git-origin` |
| 命令 | `git …` | `utils/gito …`（同 git，只是换了 git 目录） |
| 入库 | `utils/`、`artifacts/*/build/`（不含 `build/single/`）、`artifacts/*/compress-*/`、README | `utils/`、`artifacts/*/src`、`assets`、`originals`、`NOTES.md/ASSETS.md`、`PLAYABLE_BRIEF.md`、README |
| 不入库 | `src/ assets/ originals/`、`build/single/` | `build/`、`compress-*/` |
| 忽略规则 | 共用 `.gitignore` + `utils/repo/exclude-build` → `.git/info/exclude` | 共用 `.gitignore` + `utils/repo/exclude-origin` → `.git-origin/info/exclude` |

两仓共用一个工作区，所以不用来回拷文件：改完源码 `utils/gito commit`，打完包 `git commit`。`utils/` 两边都有（工具随源码走，也随产物走）。

## 为什么不用两个 .gitignore

`.gitignore` 是工作区文件，两个仓都会读到它，且优先级高于 `info/exclude`——公开仓那条 `/artifacts/**` 若写在 `.gitignore` 里，源码仓也会把 src 忽略掉，`info/exclude` 里再怎么写 `!` 都翻不回来。所以 `.gitignore` 只放两仓共同的规则（node_modules、.DS_Store、IDE 目录、`.git-origin/`），仓专属规则放 `utils/repo/exclude-*`，由 `setup.sh` 装进各自的 `info/exclude`（这个文件不随 clone 走，所以要有 setup 脚本）。

## 新机器 / 新 clone

```bash
git clone git@github.com:wangyu-ctw/arti-playable-origin.git arti-playable && cd arti-playable
mv .git .git-origin                    # 刚 clone 的是源码仓，让它住到 .git-origin
git clone --no-checkout git@github.com:wangyu-ctw/arti-playable.git .tmp-build && mv .tmp-build/.git .git && rm -rf .tmp-build
git reset -q                           # 公开仓的索引对齐工作区（build/ 目录本地先跑一次打包再 commit）
sh utils/repo/setup.sh                 # 装 exclude、核对远端
cd utils && npm install                # esbuild
```

或者反过来先 clone 公开仓再把源码仓挂到 `.git-origin`，效果一样。`setup.sh` 幂等，改了 `exclude-*` 后重跑即可生效。

## 日常

```bash
utils/gito status                      # 源码仓状态
utils/gito add -A && utils/gito commit -m "hotd-1：xxx" && utils/gito push
node utils/build.mjs hotd-1            # 打包 → build/
git add -A && git commit -m "hotd-1：xxx 打包" && git push
```

`build/single/`（渠道上传包 zip）默认两边都不入库：产物仓嫌它每次重打 ~10MB 全变；要留档就删掉 `exclude-build` 里那行再跑 `setup.sh`。
