# Git 命令大全（含作用说明）

> 数据来源：`git help -a`（Git 2.53.0，中文环境）。
> 查看单个命令的详细用法：`git help <command>`（如 `git help rebase`），等价于 `git <command> --help`。
> 部分新增命令在当前语言环境下官方描述仍为英文，此处已一并译为中文。

## 一、主要上层命令（日常使用）

| 命令 | 作用 |
| --- | --- |
| add | 添加文件内容至索引 |
| am | 应用邮箱格式的系列补丁 |
| archive | 基于一个指定的树创建文件存档 |
| backfill | 下载部分克隆（partial clone）中缺失的对象 |
| bisect | 通过二分查找定位引入 bug 的提交 |
| branch | 列出、创建或删除分支 |
| bundle | 通过归档移动对象和引用 |
| checkout | 切换分支或恢复工作区文件 |
| cherry-pick | 应用一些现存提交引入的修改 |
| citool | git-commit 的图形替代界面 |
| clean | 从工作区中删除未跟踪文件 |
| clone | 克隆仓库到一个新目录 |
| commit | 记录变更到仓库 |
| describe | 基于一个现存的引用为一个对象起一个可读的名称 |
| diff | 显示提交之间、提交和工作区之间等的差异 |
| fetch | 从另外一个仓库下载对象和引用 |
| format-patch | 准备电子邮件提交的补丁 |
| gc | 清除不必要的文件和优化本地仓库 |
| gitk | Git 仓库浏览器（图形界面） |
| grep | 输出和模式匹配的行 |
| gui | 一个便携的 Git 图形客户端 |
| init | 创建一个空的 Git 仓库或重新初始化一个已存在的仓库 |
| log | 显示提交日志 |
| maintenance | 运行任务以优化仓库数据 |
| merge | 合并两个或更多开发历史 |
| mv | 移动或重命名一个文件、目录或符号链接 |
| notes | 添加或检查对象注解 |
| pull | 获取并整合另外的仓库或一个本地分支 |
| push | 更新远程引用和相关的对象 |
| range-diff | 比较两个提交范围（如一个分支的两个版本） |
| rebase | 在另一个分支上重新应用提交 |
| reset | 将 HEAD 或索引重置到已知状态 |
| restore | 恢复工作区文件 |
| revert | 还原一些现有提交 |
| rm | 从工作区和索引中删除文件 |
| scalar | 管理大型 Git 仓库的工具 |
| shortlog | 汇总 'git log' 输出 |
| show | 显示各种类型的对象 |
| sparse-checkout | 将工作区缩减至已追踪文件的子集 |
| stash | 储藏脏工作区中的修改 |
| status | 显示工作区状态 |
| submodule | 初始化、更新或检查子模组 |
| switch | 切换分支 |
| tag | 创建、列出、删除或验证标签 |
| worktree | 管理多个工作区 |

## 二、辅助命令 / 操作类

| 命令 | 作用 |
| --- | --- |
| config | 获取和设置仓库或者全局选项 |
| fast-export | Git 数据导出器 |
| fast-import | Git 快速数据导入器后端 |
| filter-branch | 重写分支 |
| mergetool | 运行合并冲突解决工具以解决合并冲突 |
| pack-refs | 打包分支和标签以实现高效的仓库访问 |
| prune | 删除对象库中所有不可达对象 |
| reflog | 管理 reflog 信息 |
| refs | 底层引用（refs）访问 |
| remote | 管理已跟踪的远程仓库集合 |
| repack | 打包仓库中未打包对象 |
| replace | 创建、列出、删除对象替换引用 |

## 三、辅助命令 / 查询类

| 命令 | 作用 |
| --- | --- |
| annotate | 使用提交信息注释文件行 |
| blame | 显示文件每一行最后修改的版本和修改者 |
| bugreport | 收集信息以供用户提交错误报告 |
| count-objects | 计算未打包对象的数量和磁盘空间占用 |
| diagnose | 生成包含诊断信息的 zip 压缩包 |
| difftool | 使用常见的差异工具显示更改 |
| fsck | 验证仓库中对象的连通性和有效性 |
| gitweb | Git Web 界面（Git 仓库的 Web 前端） |
| help | 显示 Git 的帮助信息 |
| instaweb | 在 gitweb 中即时浏览当前工作仓库 |
| merge-tree | 执行合并但不触碰索引或工作区 |
| rerere | 重用已记录的冲突合并解决方案 |
| show-branch | 显示分支和提交 |
| verify-commit | 检查提交的 GPG 签名 |
| verify-tag | 检查标签的 GPG 签名 |
| version | 显示 Git 的版本信息 |
| whatchanged | 显示日志及每次提交引入的差异 |

## 四、与其他系统交互

| 命令 | 作用 |
| --- | --- |
| archimport | 将一个 GNU Arch 仓库导入到 Git |
| cvsexportcommit | 将一个提交导出到 CVS 检出中 |
| cvsimport | 从其他配置管理系统（CVS）导入数据 |
| cvsserver | Git 的一个 CVS 服务模拟器 |
| imap-send | 从标准输入将一组补丁发送到 IMAP 文件夹 |
| p4 | 导入和提交到 Perforce 仓库 |
| quiltimport | 将一个 quilt 补丁集应用到当前分支 |
| request-pull | 生成待处理变更的摘要 |
| send-email | 通过电子邮件发送一组补丁 |
| svn | Subversion 仓库和 Git 之间的双向操作 |

## 五、低级命令 / 操作类（底层 plumbing）

| 命令 | 作用 |
| --- | --- |
| apply | 应用一个补丁到文件和/或索引区 |
| checkout-index | 从索引复制文件到工作区 |
| commit-graph | 写入和校验 Git 提交图文件 |
| commit-tree | 创建一个新的提交对象 |
| hash-object | 计算对象 ID，并可选地从文件创建对象 |
| index-pack | 从一个现存的包存档文件创建包索引 |
| merge-file | 运行一个三路文件合并 |
| merge-index | 对于需要合并的文件执行合并 |
| mktag | 创建一个有额外验证的标签对象 |
| mktree | 基于 ls-tree 的格式化文本创建一个树对象 |
| multi-pack-index | 写入和校验多包索引 |
| pack-objects | 创建对象的存档包 |
| prune-packed | 删除已经在包文件中的多余对象 |
| read-tree | 将树信息读取到索引 |
| replay | 实验性：在新的基础上重放提交，也支持裸仓库 |
| symbolic-ref | 读取、修改和删除符号引用 |
| unpack-objects | 从打包文件中解压缩对象 |
| update-index | 将工作区的文件内容注册到索引 |
| update-ref | 安全地更新存储于引用中的对象名称 |
| write-tree | 从当前索引创建一个树对象 |

## 六、低级命令 / 查询类

| 命令 | 作用 |
| --- | --- |
| cat-file | 提供仓库对象的内容或详细信息 |
| cherry | 查找尚未应用到上游的提交 |
| diff-files | 比较工作区和索引区中的文件 |
| diff-index | 将一个树和工作区或索引做比较 |
| diff-pairs | 比较给定 blob 对的内容和模式 |
| diff-tree | 比较两个树对象的文件内容和模式 |
| for-each-ref | 对每一个引用输出信息 |
| for-each-repo | 在一个仓库列表上运行 Git 命令 |
| get-tar-commit-id | 从 git-archive 创建的归档文件中提取提交 ID |
| last-modified | 实验性：显示文件最后修改时间 |
| ls-files | 显示索引和工作区中文件的信息 |
| ls-remote | 显示一个远程仓库的引用 |
| ls-tree | 显示一个树对象的内容 |
| merge-base | 为了合并查找尽可能好的公共祖先提交 |
| name-rev | 查找给定版本的符号名称 |
| pack-redundant | 查找冗余的包文件 |
| repo | 获取仓库的相关信息 |
| rev-list | 按时间逆序列出提交对象 |
| rev-parse | 选出并处理参数（解析提交、分支、引用等） |
| show-index | 显示打包归档索引 |
| show-ref | 显示本地仓库中的引用 |
| unpack-file | 用 blob 数据对象的内容创建一个临时文件 |
| var | 显示一个 Git 逻辑变量 |
| verify-pack | 校验打包的 Git 归档文件 |

## 七、低级命令 / 同步仓库

| 命令 | 作用 |
| --- | --- |
| daemon | 一个非常简单的 Git 仓库服务器 |
| fetch-pack | 从另一个仓库获取缺失的对象 |
| http-backend | Git HTTP 协议的服务端实现 |
| send-pack | 使用 Git 协议推送对象到另一个仓库 |
| update-server-info | 更新辅助信息文件以帮助哑协议（dumb protocol）服务器 |

## 八、低级命令 / 内部辅助程序

| 命令 | 作用 |
| --- | --- |
| check-attr | 显示 gitattributes 信息 |
| check-ignore | 调试 gitignore / exclude 文件 |
| check-mailmap | 显示联系人的规范名称和电子邮件 |
| check-ref-format | 确保引用名称格式正确 |
| column | 以列的方式显示数据 |
| credential | 检索和存储用户密码 |
| credential-cache | 在内存中临时存储密码的助手 |
| credential-store | 在磁盘存储密码的助手 |
| fmt-merge-msg | 生成一个合并提交信息 |
| hook | 运行 git 钩子 |
| interpret-trailers | 添加或解析提交说明中的结构化信息 |
| mailinfo | 从单个电子邮件中提取补丁和作者身份 |
| mailsplit | 简单的 UNIX mbox 邮箱切分程序 |
| merge-one-file | 与 git-merge-index 一起使用的标准辅助程序 |
| patch-id | 计算一个补丁的唯一 ID |
| sh-i18n | 为 shell 脚本准备的 Git 国际化设置代码 |
| sh-setup | 常用的 Git shell 脚本设置代码 |
| stripspace | 删除不必要的空白字符 |

## 九、面向用户的概念与文件接口文档（`git help <name>` 可查看）

| 名称 | 作用 |
| --- | --- |
| attributes | 定义路径的属性 |
| cli | Git 命令行界面和约定 |
| hooks | Git 使用的钩子 |
| ignore | 指定故意忽略的未跟踪文件 |
| mailmap | 映射作者/提交者的名称和/或邮件地址 |
| modules | 定义子模组属性 |
| repository-layout | Git 仓库布局 |
| revisions | 指定 Git 的版本和范围 |

## 十、面向开发者的文件格式与协议文档

| 名称 | 作用 |
| --- | --- |
| format-bundle | bundle 文件格式 |
| format-chunk | 基于块（chunk）的文件格式 |
| format-commit-graph | Git commit-graph 格式 |
| format-index | Git 索引格式 |
| format-pack | Git pack 格式 |
| format-signature | Git 加密签名格式 |
| protocol-capabilities | 协议 v0 和 v1 能力（capabilities） |
| protocol-common | 各种协议的通用内容 |
| protocol-http | 基于 HTTP 的 Git 协议 |
| protocol-pack | pack 在网络上的传输方式 |
| protocol-v2 | Git 线上协议版本 2 |

## 十一、外部命令

| 命令 | 说明 |
| --- | --- |
| gui | 便携式 Git 图形客户端（外部安装） |
| lfs | Git Large File Storage，大文件存储支持（外部安装） |
