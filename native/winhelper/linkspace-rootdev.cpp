// linkspace-rootdev.exe —— 为 VDD 驱动创建持久化根设备节点（线 3，设备节点创建）。
//
// 用途：`pnputil /add-driver` 只把驱动包暂存进驱动库；在一台从未装过 VDD
// 的机器上，设备节点本身（硬件 ID Root\MttVDD）还需另一步创建。本助手
// 就是这一步，由 VddDriverManager.ensureInstalled() 在节点缺失时调用。
// 单用途：只建这一个节点，不做其他设备操作。
//
// 做法（与 devcon install 同款 API 序列，见 Microsoft Learn
// "Using the DevCon Tool to Install a Driver Package"；devcon 本身是
// WDK 样例工具、不是可依赖的随包二进制，故按同一序列自写）：
//   1. 按硬件 ID 查 Display 类现存节点——已存在则跳过创建（幂等，重跑
//      安装不会造出重复节点）。
//   2. SetupDiCreateDeviceInfoList(Display 类) →
//      SetupDiCreateDeviceInfo(设备名取硬件 ID 去掉 "Root\" 前缀，
//      DICD_GENERATE_ID) → SPDRP_HARDWAREID 写硬件 ID →
//      SetupDiCallClassInstaller(DIF_REGISTERDEVICE)。
//      注册出的节点是持久化根枚举节点（与 zero 现有的 ROOT\DISPLAY\0001
//      同类），随重启保留；实例 ID 由系统生成（全新机器上一般是
//      ROOT\DISPLAY\0000），调用方按硬件 ID 查找，不依赖实例 ID。
//   3. UpdateDriverForPlugAndPlayDevices(硬件 ID, INF 路径，
//      INSTALLFLAG_FORCE)：把已暂存的驱动装到该节点上并启动。
//
// 为什么不用 SwDeviceCreate：Microsoft Learn 明确写 "After this handle
// is closed, PnP will remove the device"——一次性助手退出即删节点，节点
// 也不随重启保留；要保住节点需常驻进程持句柄，等于给 LinkSpace 加一个
// 后台守护进程，代价远超收益，且与“节点持久化、开关由设置页/会话控制”
// 的设计冲突。故不用。
// 为什么不直接随包带 WDK 的 devcon.exe：devcon 是 WDK 样例工具，不在
// WDK 可再分发清单里，塞进闭源发行包（Route B）是许可证灰区；且它是
// 通用设备管理工具（可删/禁任意设备），随包带一个通用工具面太大。
//
// 构建：EWDK 28000.2526（D:\dev\iddcx\EWDK_28000.2526.iso），见 build.cmd。
// /MT 静态链接 CRT，目标机无需 VC 运行库。退出码见 main() 注释；
// 失败时 stderr 有 "error 0x........ at <阶段>"，供调用方拼 detail。
// 本程序不改 Secure Boot、不开 test signing、不写注册表信任项。

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <setupapi.h>
#include <newdev.h>
#include <cfgmgr32.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "newdev.lib")

// Display 设备类的 GUID：{4d36e968-e325-11ce-bfc1-08002be10318}
static const GUID GUID_DEVCLASS_DISPLAY = {
    0x4d36e968, 0xe325, 0x11ce, {0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18}
};

static void PrintError(const wchar_t *stage) {
    fwprintf(stderr, L"error 0x%08lX at %s\n", GetLastError(), stage);
}

// 在 Display 类现存设备里找硬件 ID 匹配的节点。找到返回 TRUE，
// instanceId 写出该节点的实例 ID；找不到返回 FALSE。
static BOOL FindDeviceByHwid(const wchar_t *hwid, wchar_t *instanceId, DWORD cchInstanceId) {
    HDEVINFO devs = SetupDiGetClassDevsW(&GUID_DEVCLASS_DISPLAY, NULL, NULL, DIGCF_PRESENT);
    if (devs == INVALID_HANDLE_VALUE) {
        PrintError(L"SetupDiGetClassDevs");
        return FALSE;
    }
    BOOL found = FALSE;
    SP_DEVINFO_DATA devInfo;
    devInfo.cbSize = sizeof(devInfo);
    for (DWORD i = 0; SetupDiEnumDeviceInfo(devs, i, &devInfo); i++) {
        wchar_t hwids[1024];
        if (!SetupDiGetDeviceRegistryPropertyW(devs, &devInfo, SPDRP_HARDWAREID, NULL,
                                               (PBYTE)hwids, sizeof(hwids), NULL)) {
            continue;
        }
        // REG_MULTI_SZ：逐串比对（大小写不敏感）
        for (const wchar_t *p = hwids; *p; p += wcslen(p) + 1) {
            if (_wcsicmp(p, hwid) == 0) {
                if (SetupDiGetDeviceInstanceIdW(devs, &devInfo, instanceId, cchInstanceId, NULL)) {
                    found = TRUE;
                }
                break;
            }
        }
        if (found) break;
    }
    SetupDiDestroyDeviceInfoList(devs);
    return found;
}

// 建节点（不存在时）并装驱动。返回进程退出码。
static int InstallRootDevice(const wchar_t *infPath, const wchar_t *hwid) {
    if (GetFileAttributesW(infPath) == INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"error: INF not found: %s\n", infPath);
        return 16;
    }

    wchar_t existingId[MAX_DEVICE_ID_LEN];
    if (FindDeviceByHwid(hwid, existingId, MAX_DEVICE_ID_LEN)) {
        wprintf(L"existing instanceId=%s\n", existingId);
    } else {
        // 设备名取硬件 ID 去掉 "Root\" 前缀（SetupDiCreateDeviceInfo 要求
        // 传不带枚举器前缀的根设备 ID，如 "MttVDD"；系统据此生成完整实例 ID）。
        const wchar_t *stem = hwid;
        if (_wcsnicmp(hwid, L"Root\\", 5) == 0) stem = hwid + 5;
        if (*stem == L'\0') {
            fwprintf(stderr, L"error: empty device id stem in hardware id: %s\n", hwid);
            return 15;
        }

        HDEVINFO devs = SetupDiCreateDeviceInfoList(&GUID_DEVCLASS_DISPLAY, NULL);
        if (devs == INVALID_HANDLE_VALUE) {
            PrintError(L"SetupDiCreateDeviceInfoList");
            return 10;
        }

        SP_DEVINFO_DATA devInfo;
        devInfo.cbSize = sizeof(devInfo);
        if (!SetupDiCreateDeviceInfoW(devs, stem, &GUID_DEVCLASS_DISPLAY, NULL, NULL,
                                      DICD_GENERATE_ID, &devInfo)) {
            PrintError(L"SetupDiCreateDeviceInfo");
            SetupDiDestroyDeviceInfoList(devs);
            return 11;
        }

        // SPDRP_HARDWAREID 是 REG_MULTI_SZ：硬件 ID + 双 \0。
        size_t hwidLen = wcslen(hwid);
        wchar_t hwidMultiSz[512];
        if (hwidLen + 2 > ARRAYSIZE(hwidMultiSz)) {
            fwprintf(stderr, L"error: hardware id too long: %s\n", hwid);
            SetupDiDestroyDeviceInfoList(devs);
            return 15;
        }
        wcscpy_s(hwidMultiSz, hwid);
        hwidMultiSz[hwidLen + 1] = L'\0';
        if (!SetupDiSetDeviceRegistryPropertyW(devs, &devInfo, SPDRP_HARDWAREID,
                                               (const BYTE *)hwidMultiSz,
                                               (DWORD)((hwidLen + 2) * sizeof(wchar_t)))) {
            PrintError(L"SetupDiSetDeviceRegistryProperty(SPDRP_HARDWAREID)");
            SetupDiDestroyDeviceInfoList(devs);
            return 12;
        }

        if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, devs, &devInfo)) {
            PrintError(L"SetupDiCallClassInstaller(DIF_REGISTERDEVICE)");
            SetupDiDestroyDeviceInfoList(devs);
            return 13;
        }

        wchar_t instanceId[MAX_DEVICE_ID_LEN];
        if (SetupDiGetDeviceInstanceIdW(devs, &devInfo, instanceId, MAX_DEVICE_ID_LEN, NULL)) {
            wprintf(L"instanceId=%s\n", instanceId);
        }
        SetupDiDestroyDeviceInfoList(devs);
    }

    BOOL rebootRequired = FALSE;
    if (!UpdateDriverForPlugAndPlayDevicesW(NULL, hwid, infPath, INSTALLFLAG_FORCE,
                                            &rebootRequired)) {
        PrintError(L"UpdateDriverForPlugAndPlayDevices");
        return 14;
    }
    if (rebootRequired) wprintf(L"rebootRequired=true\n");
    wprintf(L"ok\n");
    return 0;
}

static int Usage(void) {
    fwprintf(stderr,
             L"linkspace-rootdev.exe — create a persistent root device node for the VDD driver\n"
             L"usage: linkspace-rootdev.exe install <infPath> <hardwareId>\n"
             L"  e.g. linkspace-rootdev.exe install C:\\...\\MttVDD.inf Root\\MttVDD\n"
             L"exit codes: 0 ok; 2 usage; 10 create list; 11 create info; 12 set hwid;\n"
             L"  13 register device; 14 install driver; 15 bad hardware id; 16 INF not found\n");
    return 2;
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && (_wcsicmp(argv[1], L"--help") == 0 || _wcsicmp(argv[1], L"-h") == 0)) {
        return Usage();
    }
    if (argc != 4 || _wcsicmp(argv[1], L"install") != 0) {
        return Usage();
    }
    return InstallRootDevice(argv[2], argv[3]);
}
