// capture.cpp — 3.2.2 取帧验证实现
//
// 为什么在 App 侧用 Desktop Duplication 而不是驱动内取帧：
//   阶段 4 的产品架构是「应用层抓帧 → 编码 → 网络发送」，驱动保持薄。
//   若 DD 在 IddCx 输出上不受支持（DXGI_ERROR_UNSUPPORTED），才需要
//   回退到驱动 SwapChainProcessor 的 TODO 块内做 GPU 拷贝 + IPC——
//   这个 PoC 的判定结果直接决定两条路线的取舍。
#include "capture.h"

#include <dxgi1_2.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <algorithm>
#include <chrono>

using namespace Microsoft::WRL;

namespace iddpoc
{
namespace
{
    struct OutputRef
    {
        ComPtr<IDXGIOutput> output;
        DXGI_OUTPUT_DESC desc;
        ComPtr<ID3D11Device> device; // 该输出所属适配器上的 D3D 设备（惰性创建）
    };

    /** 枚举全部适配器上的全部输出；desc.DeviceName 作为输出身份 */
    std::vector<OutputRef> EnumerateOutputs()
    {
        std::vector<OutputRef> refs;
        ComPtr<IDXGIFactory1> factory;
        if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return refs;

        ComPtr<IDXGIAdapter1> adapter;
        for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a)
        {
            ComPtr<IDXGIOutput> output;
            for (UINT o = 0; adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; ++o)
            {
                OutputRef ref;
                if (SUCCEEDED(output->GetDesc(&ref.desc)))
                {
                    ref.output = output;
                    ref.device = nullptr;
                    refs.push_back(ref);
                }
            }
        }
        return refs;
    }

    /** CRC32（IEEE，反射输入），用于证明 BMP 内容非恒定 */
    DWORD Crc32(const BYTE* data, size_t len)
    {
        DWORD crc = 0xFFFFFFFFu;
        for (size_t i = 0; i < len; ++i)
        {
            crc ^= data[i];
            for (int b = 0; b < 8; ++b)
                crc = (crc >> 1) ^ ((crc & 1) ? 0xEDB88320u : 0u);
        }
        return ~crc;
    }

    /**
     * 首帧 → CPU staging 拷贝 → Map → 落 32bpp BMP（负高度 = 顶行在前）。
     * 同时计算 CRC32 与亮度范围；全黑（min=max=0）会被判定为「取到帧但内容为空」。
     */
    HRESULT SaveBmpAndProbe(ID3D11Device* device, IDXGIResource* res,
                            const std::wstring& path, DWORD& crcOut,
                            BYTE& lumMinOut, BYTE& lumMaxOut)
    {
        ComPtr<ID3D11Texture2D> tex;
        HRESULT hr = res->QueryInterface(IID_PPV_ARGS(&tex));
        if (FAILED(hr)) return hr;

        D3D11_TEXTURE2D_DESC td{};
        tex->GetDesc(&td);

        D3D11_TEXTURE2D_DESC sd = td;
        sd.Usage = D3D11_USAGE_STAGING;
        sd.BindFlags = 0;
        sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        sd.MiscFlags = 0;

        ComPtr<ID3D11Texture2D> staging;
        hr = device->CreateTexture2D(&sd, nullptr, &staging);
        if (FAILED(hr)) return hr;

        ComPtr<ID3D11DeviceContext> ctx;
        device->GetImmediateContext(&ctx);
        ctx->CopyResource(staging.Get(), tex.Get());

        D3D11_MAPPED_SUBRESOURCE map{};
        hr = ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &map);
        if (FAILED(hr)) return hr;

        const UINT w = td.Width, h = td.Height;
        const UINT bpp = 4; // 假定 BGRA；swapchain 表面在 IddCx 下就是 B8G8R8A8
        // BITMAPFILEHEADER(14) + BITMAPINFOHEADER(40)，无调色板
        const DWORD dataSize = w * h * bpp;
        const DWORD fileSize = 14 + 40 + dataSize;
        std::vector<BYTE> file(fileSize);
        auto* fh = reinterpret_cast<BITMAPFILEHEADER*>(file.data());
        fh->bfType = 0x4D42; // 'BM'
        fh->bfSize = fileSize;
        fh->bfOffBits = 14 + 40;
        auto* ih = reinterpret_cast<BITMAPINFOHEADER*>(file.data() + 14);
        ih->biSize = 40;
        ih->biWidth = (LONG)w;
        ih->biHeight = -(LONG)h; // 顶行在前，匹配 Map 布局
        ih->biPlanes = 1;
        ih->biBitCount = 32;
        ih->biCompression = BI_RGB;

        BYTE* dst = file.data() + 14 + 40;
        BYTE lumMin = 255, lumMax = 0;
        for (UINT y = 0; y < h; ++y)
        {
            const BYTE* src = (const BYTE*)map.pData + (size_t)y * map.RowPitch;
            memcpy(dst + (size_t)y * w * bpp, src, (size_t)w * bpp);
            for (UINT x = 0; x < w; ++x)
            {
                // ITU-R BT.601 亮度近似，抽样 4 像素足够判定非空
                if ((x | y) % 4 == 0)
                {
                    BYTE lum = (BYTE)((src[x * 4] + src[x * 4 + 1] * 2 + src[x * 4 + 2]) / 4);
                    lumMin = min(lumMin, lum);
                    lumMax = max(lumMax, lum);
                }
            }
        }
        ctx->Unmap(staging.Get(), 0);

        crcOut = Crc32(file.data() + 14 + 40, dataSize);
        lumMinOut = lumMin;
        lumMaxOut = lumMax;

        std::ofstream f(path.c_str(), std::ios::binary);
        if (!f) return E_FAIL;
        f.write((const char*)file.data(), file.size());
        return f ? S_OK : E_FAIL;
    }

    struct CaptureStat
    {
        std::wstring deviceName;
        LONG x = 0, y = 0, w = 0, h = 0;
        std::wstring adapterDesc;
        UINT frames = 0, timeouts = 0, errors = 0;
        double avgIntervalMs = 0;
        bool ddSupported = false;
        bool bmpSaved = false;
        DWORD crc = 0;
        BYTE lumMin = 0, lumMax = 0;
        HRESULT dupHr = 0;
    };

    /** 对单个输出做 DD 抓帧循环 */
    CaptureStat CaptureOne(OutputRef& ref, int seconds, const std::wstring& bmpPath)
    {
        CaptureStat st;
        st.deviceName = ref.desc.DeviceName;
        st.x = ref.desc.DesktopCoordinates.left;
        st.y = ref.desc.DesktopCoordinates.top;
        st.w = ref.desc.DesktopCoordinates.right - ref.desc.DesktopCoordinates.left;
        st.h = ref.desc.DesktopCoordinates.bottom - ref.desc.DesktopCoordinates.top;
        // 记录所属适配器名，虚拟输出常与真实 GPU 同适配器或落在 WARP 上，实证记录
        ComPtr<IDXGIAdapter1> adapter;
        if (SUCCEEDED(ref.output->GetParent(IID_PPV_ARGS(&adapter))))
        {
            DXGI_ADAPTER_DESC1 ad{};
            if (SUCCEEDED(adapter->GetDesc1(&ad))) st.adapterDesc = ad.Description;
        }

        ComPtr<IDXGIOutput1> out1;
        if (FAILED(ref.output->QueryInterface(IID_PPV_ARGS(&out1))))
        {
            st.dupHr = E_NOINTERFACE;
            return st;
        }
        if (!ref.device)
        {
            D3D_FEATURE_LEVEL fl{};
            if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
                                         nullptr, 0, D3D11_SDK_VERSION, &ref.device, &fl, nullptr)))
            {
                st.dupHr = E_FAIL;
                return st;
            }
        }

        ComPtr<IDXGIOutputDuplication> dup;
        st.dupHr = out1->DuplicateOutput(ref.device.Get(), &dup);
        if (FAILED(st.dupHr)) return st;
        st.ddSupported = true;

        auto t0 = std::chrono::steady_clock::now();
        auto lastFrame = t0;
        double intervalSumMs = 0;
        const auto deadline = t0 + std::chrono::seconds(seconds);
        bool firstSaved = false;
        DWORD tick = 0;

        while (std::chrono::steady_clock::now() < deadline)
        {
            // 每 400ms 晃 1px 鼠标，强制合成器产出新帧（静态桌面 DD 无帧）
            if (++tick % 2 == 0)
            {
                INPUT in{};
                in.type = INPUT_MOUSE;
                in.mi.dwFlags = MOUSEEVENTF_MOVE;
                in.mi.dx = (tick % 4 == 0) ? 3 : -3;
                SendInput(1, &in, sizeof(INPUT));
            }

            DXGI_OUTDUPL_FRAME_INFO info{};
            ComPtr<IDXGIResource> res;
            HRESULT hr = dup->AcquireNextFrame(500, &info, &res);
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) { st.timeouts++; continue; }
            if (FAILED(hr)) { st.errors++; break; }

            auto now = std::chrono::steady_clock::now();
            if (st.frames > 0)
                intervalSumMs += std::chrono::duration<double, std::milli>(now - lastFrame).count();
            lastFrame = now;
            st.frames++;

            if (!firstSaved)
            {
                firstSaved = true;
                st.bmpSaved = SUCCEEDED(SaveBmpAndProbe(ref.device.Get(), res.Get(), bmpPath,
                                                        st.crc, st.lumMin, st.lumMax));
            }
            dup->ReleaseFrame();
        }
        if (st.frames > 1)
            st.avgIntervalMs = intervalSumMs / (st.frames - 1);
        return st;
    }

    void PrintStat(const CaptureStat& st, const wchar_t* bmpName)
    {
        wprintf(L"[capture] %s rect=(%ld,%ld %ldx%ld) adapter=%s\n",
                st.deviceName.c_str(), st.x, st.y, st.w, st.h,
                st.adapterDesc.c_str());
        if (!st.ddSupported)
        {
            wprintf(L"[capture]   DuplicateOutput FAILED hr=0x%08lX —— DD 不支持该 IddCx 输出，"
                    L"阶段 4 需改驱动内取帧路线\n", (unsigned long)st.dupHr);
            return;
        }
        wprintf(L"[capture]   frames=%u timeouts=%u errors=%u avgInterval=%.1fms (~%.1ffps)\n",
                st.frames, st.timeouts, st.errors, st.avgIntervalMs,
                st.avgIntervalMs > 0 ? 1000.0 / st.avgIntervalMs : 0.0);
        wprintf(L"[capture]   bmp=%s saved=%d crc32=0x%08lX lum=[%u,%u]%s\n",
                bmpName, st.bmpSaved ? 1 : 0, (unsigned long)st.crc, st.lumMin, st.lumMax,
                (st.bmpSaved && st.lumMin == 0 && st.lumMax == 0) ? L" (全黑！内容为空)" : L"");
    }

    void AppendJsonl(const std::wstring& reportPath, const CaptureStat& st, const wchar_t* bmpName)
    {
        std::wofstream f(reportPath.c_str(), std::ios::app);
        if (!f) return;
        f << L"{\"device\":\"" << st.deviceName << L"\",\"rect\":["
          << st.x << L"," << st.y << L"," << st.w << L"," << st.h
          << L"],\"adapter\":\"" << st.adapterDesc
          << L"\",\"ddSupported\":" << (st.ddSupported ? L"true" : L"false")
          << L",\"dupHr\":\"0x" << std::hex << (unsigned long)st.dupHr << std::dec
          << L"\",\"frames\":" << st.frames
          << L",\"timeouts\":" << st.timeouts
          << L",\"errors\":" << st.errors
          << L",\"avgIntervalMs\":" << st.avgIntervalMs
          << L",\"bmp\":\"" << (st.bmpSaved ? bmpName : L"")
          << L"\",\"crc32\":\"0x" << std::hex << (unsigned long)st.crc << std::dec
          << L"\",\"lumMin\":" << (int)st.lumMin
          << L",\"lumMax\":" << (int)st.lumMax << L"}\n";
    }
}

std::vector<std::wstring> SnapshotOutputs()
{
    std::vector<std::wstring> names;
    for (auto& r : EnumerateOutputs())
        if (r.desc.AttachedToDesktop)
            names.push_back(r.desc.DeviceName);
    std::sort(names.begin(), names.end());
    return names;
}

int CaptureNewOutputs(const std::vector<std::wstring>& before, int seconds, const std::wstring& outDir)
{
    auto now = SnapshotOutputs();
    std::vector<std::wstring> fresh;
    std::set_difference(now.begin(), now.end(), before.begin(), before.end(),
                        std::back_inserter(fresh));
    if (fresh.empty())
    {
        wprintf(L"[capture] 未发现新增输出（before=%zu after=%zu）——虚拟显示器未出现\n",
                before.size(), now.size());
        return 0;
    }
    wprintf(L"[capture] 新增 %zu 个输出:", fresh.size());
    for (auto& n : fresh) wprintf(L" %s", n.c_str());
    wprintf(L"\n");

    CreateDirectoryW(outDir.c_str(), nullptr);

    auto refs = EnumerateOutputs();
    int captured = 0;
    for (auto& name : fresh)
    {
        for (auto& ref : refs)
        {
            if (ref.desc.DeviceName != name || !ref.desc.AttachedToDesktop) continue;
            wchar_t bmpName[64];
            swprintf_s(bmpName, L"frame-%s.bmp", name.c_str() + 4); // 去掉 \\.\ 前缀
            CaptureStat st = CaptureOne(ref, seconds, outDir + L"\\" + bmpName);
            PrintStat(st, bmpName);
            AppendJsonl(outDir + L"\\capture-report.jsonl", st, bmpName);
            captured++;
        }
    }
    return captured;
}
}
