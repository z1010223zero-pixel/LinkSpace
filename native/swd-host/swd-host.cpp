// swd-host.cpp — 虚拟显示器的会话级宿主进程
//
// 线 3（3.2-1）：VirtualDisplayManager（主进程）spawn 这个进程来创建
// 虚拟显示器，会话结束时杀掉它来销毁。只做两件事：
//   1. SwDeviceCreate 创建 IddSampleDriver 软件设备（与 PoC main.cpp
//      同一块创建参数，硬件 ID 与 .inf 一致）；
//   2. 等待退出信号：Ctrl-C / stdin EOF / 进程被杀。正常退出时调
//      SwDeviceClose；被杀时句柄由系统关闭，PnP 同样摘掉设备
//      （待驱动装上后实测确认 kill 后输出集合回到创建前，见 README）。
//
// 与 PoC 的 IddSampleApp.exe 的区别：不跑 8 秒取帧验证、不写 BMP/
// jsonl、不等键盘 'x'——它就是 PoC 的交互式等待循环，不适合当
// 会话宿主。模式仍是 Driver.cpp 里预置的固定模式（2560×1440
// @144/90/60、1024×768 @75/60）；按请求尺寸选模式以后加。
//
// stdout 协议（主进程据此判断状态）：
//   - `SWD-READY`：设备已创建（CreationCallback 已回）
//   - `SWD-DISPLAY-APPEARED <n>`：轮询到新输出出现，n 为当前输出总数
//   - `SWD-DISPLAY-TIMEOUT`：20s 内新输出未出现（驱动未装/签名问题
//     时会出现；进程继续活着，主进程按自己的超时判失败并杀进程）
//   - `SWD-CLOSED <before> <after>`：正常关闭后的输出集合计数
// stderr 只打诊断。
#include <windows.h>
#include <swdevice.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdio>
#include <string>
#include <vector>
#include <algorithm>

using namespace Microsoft::WRL;

namespace
{
HANDLE g_exitEvent = nullptr;

BOOL WINAPI CtrlHandler(DWORD ctrlType)
{
    if (ctrlType == CTRL_C_EVENT || ctrlType == CTRL_BREAK_EVENT ||
        ctrlType == CTRL_CLOSE_EVENT)
    {
        if (g_exitEvent) SetEvent(g_exitEvent);
        return TRUE;
    }
    return FALSE;
}

DWORD WINAPI StdinWatcher(LPVOID)
{
    // stdin 被主进程关掉（管道断）→ 视为退出信号；交互式运行 stdin
    // 是控制台，getchar 会一直等，不影响正常等待
    for (;;)
    {
        int c = getchar();
        if (c == EOF)
        {
            if (g_exitEvent) SetEvent(g_exitEvent);
            return 0;
        }
    }
}

size_t SnapshotOutputCount()
{
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return 0;
    size_t n = 0;
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; ; ++a)
    {
        // EnumAdapters1/EnumOutputs 失败不只有 NOT_FOUND：SSH/服务会话里
        // 会返回 DXGI_ERROR_NOT_CURRENTLY_AVAILABLE（0x887A0022），此时
        // output 仍是空指针；旧写法只判 NOT_FOUND，进循环体调 GetDesc
        // 直接 AV（0xC0000005，2026-11-03 会话 0 实测）。任何失败都跳出。
        adapter.Reset();
        HRESULT eaHr = factory->EnumAdapters1(a, &adapter);
        if (eaHr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(eaHr)) break;
        for (UINT o = 0; ; ++o)
        {
            ComPtr<IDXGIOutput> output;
            HRESULT eoHr = adapter->EnumOutputs(o, &output);
            if (eoHr == DXGI_ERROR_NOT_FOUND) break;
            if (FAILED(eoHr)) break;
            DXGI_OUTPUT_DESC desc{};
            if (SUCCEEDED(output->GetDesc(&desc)) && desc.AttachedToDesktop) ++n;
        }
    }
    return n;
}

bool WaitForNewOutput(size_t before, int timeoutSec)
{
    for (int i = 0; i < timeoutSec * 2; ++i)
    {
        if (SnapshotOutputCount() > before) return true;
        Sleep(500);
    }
    return false;
}

VOID WINAPI CreationCallback(HSWDEVICE, HRESULT hrCreateResult, PVOID pContext, PCWSTR)
{
    if (FAILED(hrCreateResult))
        fprintf(stderr, "[swd-host] SwDeviceCreate 回调失败 hr=0x%08lX\n",
                (unsigned long)hrCreateResult);
    SetEvent(*(HANDLE*)pContext);
}
} // namespace

int __cdecl main()
{
    setvbuf(stdout, nullptr, _IONBF, 0);
    g_exitEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    SetConsoleCtrlHandler(CtrlHandler, TRUE);
    CreateThread(nullptr, 0, StdinWatcher, nullptr, 0, nullptr);

    const size_t before = SnapshotOutputCount();
    fprintf(stderr, "[swd-host] 创建前输出: %zu 个\n", before);

    HANDLE hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    HSWDEVICE hSwDevice = nullptr;
    SW_DEVICE_CREATE_INFO createInfo = { 0 };
    PCWSTR description = L"Idd Sample Driver";
    PCWSTR instanceId = L"IddSampleDriver";
    PCWSTR hardwareIds = L"IddSampleDriver\0\0";
    PCWSTR compatibleIds = L"IddSampleDriver\0\0";
    createInfo.cbSize = sizeof(createInfo);
    createInfo.pszzCompatibleIds = compatibleIds;
    createInfo.pszInstanceId = instanceId;
    createInfo.pszzHardwareIds = hardwareIds;
    createInfo.pszDeviceDescription = description;
    createInfo.CapabilityFlags = SWDeviceCapabilitiesRemovable |
                                 SWDeviceCapabilitiesSilentInstall |
                                 SWDeviceCapabilitiesDriverRequired;

    HRESULT hr = SwDeviceCreate(L"IddSampleDriver", L"HTREE\\ROOT\\0",
                                &createInfo, 0, nullptr,
                                CreationCallback, &hEvent, &hSwDevice);
    if (FAILED(hr))
    {
        fprintf(stderr, "[swd-host] SwDeviceCreate failed 0x%08lX\n", (unsigned long)hr);
        return 1;
    }
    if (WaitForSingleObject(hEvent, 10 * 1000) != WAIT_OBJECT_0)
    {
        fprintf(stderr, "[swd-host] 等待设备创建回调超时\n");
        return 1;
    }
    printf("SWD-READY\n");

    if (WaitForNewOutput(before, 20))
        printf("SWD-DISPLAY-APPEARED %zu\n", SnapshotOutputCount());
    else
        printf("SWD-DISPLAY-TIMEOUT\n");

    // 会话宿主：一直等到 Ctrl-C / stdin EOF / 被杀
    WaitForSingleObject(g_exitEvent, INFINITE);
    SwDeviceClose(hSwDevice);
    const size_t after = SnapshotOutputCount();
    printf("SWD-CLOSED %zu %zu\n", before, after);
    return 0;
}
