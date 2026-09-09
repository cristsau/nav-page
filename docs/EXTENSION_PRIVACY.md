# DOMO NAV Quick Add 隐私政策 / Privacy Policy

生效及更新日期 / Effective and updated: **2026-09-09**  
发布者 / Publisher: **Domo Studio**  
适用产品 / Product: **DOMO NAV Quick Add for Microsoft Edge, version 1.2.1**

本政策说明扩展及完成其登录、分组和收藏功能所需的配套服务如何处理数据。发布本政策不代表扩展已经通过商店审核。本文补充安装包内的简要权限说明；它不是 Google 或 Microsoft 的隐私政策。

## 一、用途和服务范围

DOMO NAV Quick Add 帮助你将当前网页或右键选择的链接保存到自己选择的 DOMO NAV 站点，可修改标题、选择或创建分组，并使用上次分组、右键菜单或快捷键收藏。

- 默认站点为 <https://nav.skrskr.net>。你也可以在扩展设置中选择 <https://nav.cristsau.cn> 或自行部署的 DOMO NAV 站点。
- 扩展需要所选站点的可用账号和登录会话。两个正式域名的登录会话各自独立；切换域名后需要在该域登录。
- 自建或第三方运营的 DOMO NAV 实例由其运营者负责服务器数据、保存期限和删除请求；请只连接你信任的服务，并查阅该服务的隐私政策。

## 二、处理哪些数据，以及何时处理

| 数据 | 实际处理方式和用途 |
| --- | --- |
| 网页网址、标题及可用 favicon 信息 | 打开收藏弹窗时读取当前标签页信息并预填表单；在你点击保存、触发收藏快捷键或选择右键收藏操作时，将相关信息发送到所选站点。右键“选择分组”会将这些信息放入所选站点的 quick-add 页面地址，因此可能出现在该页面地址和浏览器访问记录中。 |
| 账号资料 | 弹窗调用所选站点的会话接口。DOMO NAV 的响应包括用户 ID、用户名、已设置的邮箱及验证状态、角色、账号状态和相关账号时间信息；弹窗显示用户名以说明正在使用哪个账号。扩展不把这些会话响应另存入浏览器同步设置。 |
| 登录会话 | 请求所选站点时，由浏览器按其规则携带该站点已有的会话 Cookie，用于验证身份和限定收藏归属。扩展不要求你在扩展内输入账号密码，不直接读取或保存 Cookie 值，也不接收人脸、指纹或设备解锁密码。 |
| 分组和扩展设置 | 从所选站点读取分组资料；创建分组或收藏时提交你选择的内容。所选站点地址、上次分组 ID 和分组名写入 `chrome.storage.sync`，以便下次继续使用。启用 Microsoft Edge 同步时，这些设置可能由 Microsoft 同步，不是仅保存在本机。 |
| 网络与安全信息 | 所选服务和提供网络传输的基础设施会处理请求 IP、User-Agent 等连接信息；DOMO NAV 的请求、安全及会话机制还会处理必要的访问或活动时间信息，用于提供服务、限流、防滥用和保护账号。安全审计中的部分关联信息使用摘要。扩展不请求 GPS 或精确位置权限。 |

“用户主动收藏”不等于“不处理浏览数据”。保存的网址可能包含查询参数、临时访问凭证或私人链接，标题也可能包含个人或敏感信息；请在提交前检查，避免收藏包含密码、验证码、私密令牌或其他不应分享给站点的内容。

扩展不持续遍历浏览历史，不扫描所有标签页，不抓取网页正文，不记录键盘输入、鼠标位置或滚动轨迹，不专门读取健康、支付、邮件、短信或聊天数据。用户主动选择的网址或标题中可能含有这类信息，仍会作为所选收藏内容处理。

## 三、权限说明

| 权限 | 用途和边界 |
| --- | --- |
| `storage` | 保存站点及上次使用的分组设置，可能受 Microsoft Edge 同步设置影响。 |
| `tabs` | 在打开弹窗或触发收藏快捷键时读取活动标签页的网址、标题和可用 favicon。该权限本身的能力范围较广，但扩展不用于后台跟踪浏览过程。 |
| `contextMenus` | 提供右键保存当前网页或所选链接，以及打开分组选择页的入口。 |
| `https://nav.skrskr.net/*` | 访问默认站点的会话、分组和收藏接口。 |
| 可选 HTTP/HTTPS 主机权限 | 支持用户选择的 DOMO NAV 实例。保存自定义地址时，只申请该具体来源的访问权限；不在安装时申请全部网站的主机访问权限。 |

扩展的 JavaScript 随安装包提供，不下载并执行远程脚本。访问 DOMO NAV 数据接口以及在标签页打开网站不等于在扩展中执行远程代码。

## 四、接收方和数据用途限制

- **所选 DOMO NAV 服务：** 接收你提交的收藏、分组以及验证请求所需的信息，以提供对应功能。切换站点不会自动迁移或删除原站点的数据。
- **Microsoft：** 如果你启用浏览器同步，扩展设置可能由 Microsoft Edge 同步；扩展商店安装和更新也由浏览器与商店处理。参见 [Microsoft 隐私声明](https://privacy.microsoft.com/privacystatement)。
- **基础设施与登录服务：** 网站运营所需的托管、代理或安全服务会按其职责处理必要网络数据。你在 DOMO NAV 网站另行选择 Google 登录、设备密钥或安全验证时，还适用该网站的 [隐私政策](https://nav.cristsau.cn/privacy)；扩展本身不会申请 Gmail、Drive、联系人或日历权限，也不会直接向广告或分析服务发送收藏内容。
- **GitHub：** 本政策和公开问题反馈托管于 GitHub。你访问这些页面时，GitHub 会按其 [隐私声明](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) 处理访问或主动提交的信息。

本扩展没有接入广告跟踪、第三方行为分析或自动上传错误内容的 SDK。Domo Studio 不出售用户数据，不为单一收藏用途之外的目的使用或转移扩展数据，不将数据用于信用评估或放贷。仅在实现用户要求的功能、必要的服务与安全处理，或适用法律要求等允许情形下处理或披露数据；不以广告定向、数据交易或用户画像为目的共享数据。

## 五、存储、安全和保留

收藏与分组由所选 DOMO NAV 服务保存。站点及上次分组设置保存在浏览器扩展存储中，启用同步时可能存在同步副本；会话响应和当前标签页信息用于当前操作，不由扩展另外建立持久浏览历史库。

两个正式站点使用 HTTPS。1.2.1 也接受用户手动配置的 HTTP 自建地址；HTTP 不提供 HTTPS 的传输保密性，请勿通过 HTTP 传输账号会话、私密收藏或其他敏感信息，应选择 HTTPS 服务。本政策不声称所有自建实例都具备相同安全配置，也不能保证任何系统绝对安全。

收藏和分组在提供服务所需期间保留，直至你删除或通过所选服务请求处理。请求日志、安全记录及备份的实际保留和清理由相应服务运营者的配置及适用义务决定，不承诺统一的即时删除或所有实例相同的固定期限。删除生产数据不一定立即清除历史备份；保留副本不用于广告或其他无关用途。

## 六、你的选择、访问与删除

1. 你可以不打开扩展、不触发收藏，或在 Microsoft Edge 扩展管理中禁用、卸载扩展，以停止后续扩展操作。
2. 可以在扩展设置中改变所选站点，并通过浏览器的站点权限及同步设置控制访问与同步。撤销所需权限后，对应功能可能不可用；已经保存到站点的数据不会因此自动删除。
3. 可在所选 DOMO NAV 站点查看、修改或删除收藏与分组，并在账号安全中退出或撤销登录会话。账号数据查询、更正、删除及保留期限问题，请联系该站点运营者。
4. 卸载扩展不等于删除服务器收藏，也不保证立即清除浏览器所有同步副本。请结合站点的数据管理、浏览器同步控制或相应服务的支持渠道处理。
5. 对 Domo Studio 运营的服务或本扩展有隐私请求，可使用下方私密联系邮箱。核验请求时只应提供必要信息；不要发送密码、验证码、Cookie、恢复码或私钥。

## 七、联系与政策更新

- 隐私联系邮箱（沿用 DOMO NAV 已公布的渠道）：[cristsaudomo@gmail.com](mailto:cristsaudomo@gmail.com)。
- 非敏感功能问题：[GitHub Issues](https://github.com/cristsau/nav-page/issues)。该页面公开可见，请勿提交私人账号信息、私密网址或凭据。

功能或数据处理方式发生变化时，我们会更新本政策并注明日期；涉及需要重新告知或取得同意的变化时，应在适用操作前完成相应告知或同意。本政策的公开发布不表示功能验收、商店认证或全部地区法律合规已经完成。

---

## English

### Scope and purpose

This policy is provided by **Domo Studio** for **DOMO NAV Quick Add for Microsoft Edge, version 1.2.1**, effective September 9, 2026. It supplements the brief permissions notice included in the package and covers the extension and the services needed for its session, group and bookmark features. Publishing this policy does not mean the extension has passed store review.

The extension saves the current page or a selected link to a DOMO NAV instance chosen by the user. The default is `https://nav.skrskr.net`; `https://nav.cristsau.cn` and self-hosted instances can be selected in settings. An account and a valid session on the selected site are required. Sessions are separate for each domain. Independent instance operators are responsible for their server data and retention practices.

### Data and permissions

- Opening the popup reads the active tab's URL, title and available favicon metadata to pre-fill the form. Saving through the popup, context menu or shortcut sends selected bookmark data to the chosen instance. The context-menu group-selection flow places this data in that site's quick-add URL, which can appear in the address bar and browsing records. Review private links and URL parameters before saving.
- The popup receives the selected site's session response. DOMO NAV returns the account ID, username, configured email and verification status, role, account status and account timestamps. The popup displays the username. The extension does not separately persist this response in synchronized settings.
- The browser may attach the selected site's existing session cookie to API requests. The extension does not ask for passwords, directly read cookie values, or receive biometric data or device unlock codes.
- Site URL and last-used group ID and name are stored using `chrome.storage.sync` and may be synchronized by Microsoft Edge when sync is enabled. Group information is retrieved from the selected instance; user-requested groups and bookmarks are stored there.
- The selected service and its infrastructure process IP addresses, User-Agent and necessary request, security or session activity metadata for service delivery, rate limiting and account protection. Some security correlations are stored as digests. The extension does not request GPS or precise location access.

`storage` supports settings, `tabs` supplies active-tab metadata on user invocation, and `contextMenus` supplies user-triggered save actions. Default host access is limited to `https://nav.skrskr.net/*`. Optional HTTP/HTTPS host permissions support custom instances; saving a custom setting requests the specific origin, not all hosts at installation.

The extension does not continuously monitor browsing, enumerate all tabs or history, scrape page bodies, record keystrokes or mouse movements, or specifically collect health, payment or private communication records. User-selected URLs and titles can themselves contain sensitive information. Scripts are packaged with the extension; remote scripts are not downloaded and executed.

### Recipients and limited use

Bookmark and group requests go to the user-selected DOMO NAV instance. Microsoft may process extension settings for Edge sync and handle store installation or updates under the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement). Necessary hosting, network and security providers process service traffic. Website login and optional website security features are covered separately by the [DOMO NAV website policy](https://nav.cristsau.cn/privacy). The extension does not request Gmail, Drive, contacts or calendar access. GitHub hosts this policy and public support under its [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

No advertising trackers, third-party behavioral analytics or automatic error-content upload SDKs are integrated. Domo Studio does not sell extension user data, use or transfer it for unrelated purposes, or use it for creditworthiness or lending. Processing or disclosure is limited to requested functionality, necessary service and security operations, or other permitted circumstances such as applicable legal obligations; not advertising targeting, profiling or data brokering.

### Security, retention and user controls

Both official sites use HTTPS. Version 1.2.1 also accepts user-configured HTTP instances. HTTP lacks HTTPS transport confidentiality; do not send account sessions, private bookmarks or other sensitive data over HTTP. Use a trusted HTTPS instance. Independent instances may have different security practices.

Bookmarks and groups remain with the selected service until deleted or otherwise handled through that service. Settings and synchronized copies follow browser storage and sync controls. Logs, security records and backups follow the relevant operator's retention settings and obligations; there is no claim of immediate deletion from all backups or a uniform retention period across instances.

You can stop using, disable or uninstall the extension, change the selected instance, and manage browser permissions and sync. Revoking permissions can prevent corresponding features from working. Disabling or uninstalling does not delete server bookmarks or necessarily erase every sync copy. Use the selected site's controls to manage bookmarks, groups and sessions, and contact its operator for account access, correction, deletion or retention questions.

For privacy requests concerning this extension or Domo Studio-operated services, contact [cristsaudomo@gmail.com](mailto:cristsaudomo@gmail.com). Use [GitHub Issues](https://github.com/cristsau/nav-page/issues) only for non-sensitive support. Never send passwords, verification codes, cookies, recovery codes, private keys or private URLs in public issues. Necessary identity checks should use only the minimum information required.

We will update this policy and its date when relevant processing changes, providing notice or obtaining consent before applicable operations where required. This policy does not certify functional acceptance, store approval or compliance in every jurisdiction.
