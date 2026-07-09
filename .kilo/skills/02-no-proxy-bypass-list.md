# 02-默认代理绕过地址补充 (Default Proxy Bypass List)

## 问题描述 (Issue Description)

软件设置中"不使用代理的地址"（`proxyBypassList`）的默认值为空字符串，导致新用户或重置配置后缺少常见的本地/内网地址绕过规则。

需要将以下 `no_proxy` 地址补充到默认值中（取两者并集）：

```
127.0.0.1,localhost,126.0.0.1,10.0.0.0/8,192.168.0.0/16,.orb.local,.local,.orb.internal,.internal
```

## 根本原因 (Root Cause)

在 `frontend/src/stores/appSettings.ts` 的默认设置对象中：

1. `proxyBypassList` 的硬编码默认值为 `''`（空字符串）
2. 初始化时若值为空，会尝试从 OS 系统代理读取：`(await ignoredError(GetSystemProxyBypass)) || ''`
3. 若 OS 无代理绕过配置，最终值仍为空，导致常用内网地址不走直连

## 修复方案 (Fix Solution)

**文件位置**: `frontend/src/stores/appSettings.ts`

**修改位置**: 默认设置对象中的 `proxyBypassList` 字段（约第 71 行）

软件的分隔符格式为**分号**（`;`），对应 UI 提示 `proxyBypassListTips: '分号分隔'`。

### 修改前代码

```typescript
proxyBypassList: '',
```

### 修改后代码

```typescript
proxyBypassList: '127.0.0.1;localhost;126.0.0.1;10.0.0.0/8;192.168.0.0/16;.orb.local;.local;.orb.internal;.internal',
```

### 注意事项

修改后，由于默认值非空，`setupAppSettings` 中的如下逻辑将不再对新用户生效：

```typescript
if (!settings.proxyBypassList) {
  settings.proxyBypassList = (await ignoredError(GetSystemProxyBypass)) || ''
}
```

即新用户不再自动继承 OS 系统代理绕过列表，而是直接使用上述硬编码默认值。

## 版本更新检查清单 (Version Update Checklist)

### ✅ 必须检查项

- [ ] 确认 `frontend/src/stores/appSettings.ts` 中 `proxyBypassList` 字段仍存在
- [ ] 检查默认值是否包含全部目标地址（分号分隔）
- [ ] 确认 UI 提示仍为"分号分隔"（`frontend/src/lang/locale/zh.ts` 的 `proxyBypassListTips`）

### 🔍 关键代码位置

在默认设置对象中搜索：

```typescript
proxyBypassList:
```

确保其值包含以下所有条目（分号分隔）：

```
127.0.0.1;localhost;126.0.0.1;10.0.0.0/8;192.168.0.0/16;.orb.local;.local;.orb.internal;.internal
```

### 🧪 测试验证

1. 清空或删除 `data/user.yaml`，重启应用
2. 进入「软件设置 → 不使用代理的地址」
3. **预期结果**：默认显示上述分号分隔的地址列表，而非空白

## 影响范围 (Impact Scope)

- **影响文件**: `frontend/src/stores/appSettings.ts`
- **影响功能**: 系统代理设置 → 不使用代理的地址（默认值）
- **风险等级**: 低（仅修改默认值，已有用户配置不受影响）
- **兼容性**: 完全向后兼容（已保存 `data/user.yaml` 中的值优先生效）

## 修复日期 (Fix Date)

- **修复日期**: 2026-07-09
- **版本**: 当前开发版本
- **修复人**: Kiro AI

## 备注 (Notes)

地址列表含义：

| 地址 | 说明 |
|------|------|
| `127.0.0.1` | 本地回环 IPv4 |
| `localhost` | 本地回环域名 |
| `126.0.0.1` | 本地回环备用 |
| `10.0.0.0/8` | A 类内网地址段 |
| `192.168.0.0/16` | C 类内网地址段 |
| `.orb.local` | OrbStack 本地域名 |
| `.local` | mDNS 本地域名 |
| `.orb.internal` | OrbStack 内部域名 |
| `.internal` | 内部服务域名 |
