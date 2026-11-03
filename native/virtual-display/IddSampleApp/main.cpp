#include <windows.h>
#include <swdevice.h>
#include <conio.h>
#include <wrl.h>

#include <iostream>
#include <vector>

#include "capture.h"

// 轮询等待虚拟显示器输出出现（D0Entry → AdapterInit → MonitorArrival 异步链）
static bool WaitForNewOutputs(const std::vector<std::wstring>& before, int timeoutSec)
{
    for (int i = 0; i < timeoutSec * 2; ++i)
    {
        if (iddpoc::SnapshotOutputs().size() > before.size()) return true;
        Sleep(500);
    }
    return false;
}

VOID WINAPI
CreationCallback(
    _In_ HSWDEVICE hSwDevice,
    _In_ HRESULT hrCreateResult,
    _In_opt_ PVOID pContext,
    _In_opt_ PCWSTR pszDeviceInstanceId
    )
{
    HANDLE hEvent = *(HANDLE*) pContext;

    SetEvent(hEvent);
    UNREFERENCED_PARAMETER(hSwDevice);
    UNREFERENCED_PARAMETER(hrCreateResult);
    UNREFERENCED_PARAMETER(pszDeviceInstanceId);
}

int __cdecl main(int argc, wchar_t *argv[])
{
    UNREFERENCED_PARAMETER(argc);
    UNREFERENCED_PARAMETER(argv);

    HANDLE hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    HSWDEVICE hSwDevice;
    SW_DEVICE_CREATE_INFO createInfo = { 0 };
    PCWSTR description = L"Idd Sample Driver";

    // These match the Pnp id's in the inf file so OS will load the driver when the device is created
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

    // PoC：SWD 创建前快照输出集合，创建后 diff 出虚拟显示器（capture.cpp）
    auto before = iddpoc::SnapshotOutputs();
    wprintf(L"[poc] SWD 创建前输出快照: %zu 个\n", before.size());

    // Create the device
    HRESULT hr = SwDeviceCreate(L"IddSampleDriver",
                                L"HTREE\\ROOT\\0",
                                &createInfo,
                                0,
                                nullptr,
                                CreationCallback,
                                &hEvent,
                                &hSwDevice);
    if (FAILED(hr))
    {
        printf("SwDeviceCreate failed with 0x%lx\n", hr);
        return 1;
    }

    // Wait for callback to signal that the device has been created
    printf("Waiting for device to be created....\n");
    DWORD waitResult = WaitForSingleObject(hEvent, 10*1000);
    if (waitResult != WAIT_OBJECT_0)
    {
        printf("Wait for device creation failed\n");
        return 1;
    }
    printf("Device created\n\n");

    // 3.2.1 判定：虚拟显示器是否出现并保持
    if (!WaitForNewOutputs(before, 20))
    {
        printf("[poc] 20s 内虚拟显示器输出未出现 —— 3.2.1 FAIL\n");
    }
    else
    {
        printf("[poc] 虚拟显示器输出已出现 —— 3.2.1 显示创建环节 OK\n");
        // 3.2.2 判定：应用层能否从虚拟输出取到帧（8s 采样，鼠标微抖强制出帧）
        int n = iddpoc::CaptureNewOutputs(before, 8, L"idd-poc-out");
        printf("[poc] 取帧验证覆盖 %d 个新输出 —— 详见 idd-poc-out\\capture-report.jsonl\n", n);
    }

    // Now wait for user to indicate the device should be stopped
    printf("Press 'x' to exit and destory the software device\n");
    bool bExit = false;
    do
    {
        // Wait for key press
        int key = _getch();

        if (key == 'x' || key == 'X')
        {
            bExit = true;
        }
    }while (!bExit);

    // Stop the device, this will cause the sample to be unloaded
    SwDeviceClose(hSwDevice);

    // 卸载后输出集合应回到 before —— 干净退出也是 3.2.1 稳定性的一部分
    auto after = iddpoc::SnapshotOutputs();
    wprintf(L"[poc] SWD 销毁后输出快照: %zu 个（期望 %zu 个）%s\n",
            after.size(), before.size(),
            after.size() == before.size() ? L"OK" : L"!! 残留虚拟输出");

    return 0;
}
