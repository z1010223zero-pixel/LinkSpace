// dd-capture.cpp — Desktop Duplication 持续取帧 → 原始 BGRA 写 stdout
//
// 线 3（3.2-1）：把帧源从 gdigrab 换成虚拟显示器的 DD 帧。用法：
//   dd-capture --rect <x> <y> <w> <h> [--fps <n>] [--frames <n>]
//
//   --rect  目标输出的桌面绝对坐标（与 session.accept 回的 virtualScreen
//           一致；验证时也可传真实显示器的矩形，DD 对任何输出都可用，
//           不需要装驱动就能验证整条 DD → 编码 → WS 管道）
//   --fps   仅作占位（DD 按内容变化出帧，无固定帧率；保留参数位供以后
//           做节流，不传默认 30）
//   --frames  采满 N 帧后正常退出 0（排障/测试用；不传则一直采到被杀）
//
// 协议（与主进程约定）：
//   - stdout：纯二进制，每帧 w*h*4 字节 BGRA、行紧排（RowPitch 的行尾
//     填充已去掉），无帧头；ffmpeg 以 -f rawvideo -pix_fmt bgra
//     -s WxH -i pipe:0 读入。
//   - stderr：诊断文本。DuplicateOutput 成功后立即打一行
//     `DD-READY <w> <h>`，主进程据此确认取帧已就绪（10s 超时则判失败）；
//     每 300 帧打一行 frames 计数。
//   - 退出码：0 采满帧数正常退出；2 找不到匹配 rect 的输出；
//     3 DuplicateOutput/AcquireNextFrame 失败；4 stdout 写失败（管道断）。
//
// 刻意不做的事：
//   - 不晃鼠标。PoC（capture.cpp）每 400ms 晃 1px 强制合成器出帧，
//     产品里绝不能动用户光标；静态桌面 DD 本来就不出帧——
//     不出帧 = 不占带宽，是期望行为，不是故障。
//   - AccessLost 后不自动重建 duplication：退出码 3 告诉主进程，
//     由主进程（screen-stream.ts）决定重建或结束流；重建逻辑以后加。
#include <windows.h>
#include <dxgi1_2.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace Microsoft::WRL;

namespace
{
struct OutputRef
{
    ComPtr<IDXGIOutput> output;
    DXGI_OUTPUT_DESC desc;
};

std::vector<OutputRef> EnumerateOutputs()
{
    std::vector<OutputRef> refs;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return refs;

    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; ; ++a)
    {
        // 与 EnumOutputs 同理：EnumAdapters1 失败也不只有 NOT_FOUND，
        // 失败时 adapter 会残留上一轮的值（首轮为空），继续用它枚举会
        // 重复旧输出或直接 AV。任何失败都跳出。
        adapter.Reset();
        HRESULT eaHr = factory->EnumAdapters1(a, &adapter);
        if (eaHr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(eaHr)) break;
        ComPtr<IDXGIOutput> output;
        for (UINT o = 0; ; ++o)
        {
            output.Reset();
            // 注意：EnumOutputs 失败不只有 NOT_FOUND——SSH 会话里会返回
            // DXGI_ERROR_NOT_CURRENTLY_AVAILABLE（0x887A0022），此时
            // output 仍是空指针；旧写法只判 NOT_FOUND，进循环体调
            // GetDesc 直接 AV（2026-11-03 实测）。任何失败都跳出。
            HRESULT eoHr = adapter->EnumOutputs(o, &output);
            if (eoHr == DXGI_ERROR_NOT_FOUND) break;
            if (FAILED(eoHr)) break;
            OutputRef ref;
            HRESULT gdHr = output->GetDesc(&ref.desc);
            if (SUCCEEDED(gdHr))
            {
                ref.output = output;
                refs.push_back(ref);
            }
        }
    }
    return refs;
}

void Usage()
{
    fprintf(stderr,
        "usage: dd-capture --rect <x> <y> <w> <h> [--fps <n>] [--frames <n>]\n");
}
} // namespace

int main(int argc, char** argv)
{
    LONG rx = 0, ry = 0, rw = 0, rh = 0;
    bool haveRect = false;
    int maxFrames = -1;
    for (int i = 1; i < argc; ++i)
    {
        if (strcmp(argv[i], "--rect") == 0 && i + 4 < argc)
        {
            rx = atol(argv[++i]); ry = atol(argv[++i]);
            rw = atol(argv[++i]); rh = atol(argv[++i]);
            haveRect = true;
        }
        else if (strcmp(argv[i], "--fps") == 0 && i + 1 < argc)
        {
            ++i; // 占位，见文件头注释
        }
        else if (strcmp(argv[i], "--frames") == 0 && i + 1 < argc)
        {
            maxFrames = atoi(argv[++i]);
        }
        else
        {
            Usage();
            return 2;
        }
    }
    if (!haveRect || rw <= 0 || rh <= 0)
    {
        Usage();
        return 2;
    }

    // 找桌面坐标完全匹配的输出（虚拟显示器由 session.accept 的矩形定位）
    auto refs = EnumerateOutputs();
    OutputRef* target = nullptr;
    for (auto& r : refs)
    {
        const auto& d = r.desc.DesktopCoordinates;
        if (d.left == rx && d.top == ry &&
            (d.right - d.left) == rw && (d.bottom - d.top) == rh)
        {
            target = &r;
            break;
        }
    }
    if (!target)
    {
        fprintf(stderr, "[dd-capture] no output at rect=(%ld,%ld %ldx%ld) (%zu outputs)\n",
                rx, ry, rw, rh, refs.size());
        for (auto& r : refs)
        {
            const auto& d = r.desc.DesktopCoordinates;
            fprintf(stderr, "[dd-capture]   %ls rect=(%ld,%ld %ldx%ld)\n",
                    r.desc.DeviceName, d.left, d.top,
                    d.right - d.left, d.bottom - d.top);
        }
        return 2;
    }
    fprintf(stderr, "[dd-capture] output %ls rect=(%ld,%ld %ldx%ld)\n",
            target->desc.DeviceName, rx, ry, rw, rh);

    ComPtr<IDXGIAdapter1> adapter;
    if (FAILED(target->output->GetParent(IID_PPV_ARGS(&adapter))))
    {
        fprintf(stderr, "[dd-capture] GetParent(adapter) failed\n");
        return 3;
    }
    ComPtr<ID3D11Device> device;
    D3D_FEATURE_LEVEL fl{};
    if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
                                 nullptr, 0, D3D11_SDK_VERSION, &device, &fl, nullptr)))
    {
        fprintf(stderr, "[dd-capture] D3D11CreateDevice failed\n");
        return 3;
    }
    ComPtr<IDXGIOutput1> out1;
    if (FAILED(target->output->QueryInterface(IID_PPV_ARGS(&out1))))
    {
        fprintf(stderr, "[dd-capture] output is not IDXGIOutput1\n");
        return 3;
    }
    ComPtr<IDXGIOutputDuplication> dup;
    HRESULT hr = out1->DuplicateOutput(device.Get(), &dup);
    if (FAILED(hr))
    {
        fprintf(stderr, "[dd-capture] DuplicateOutput FAILED hr=0x%08lX\n", (unsigned long)hr);
        return 3;
    }
    // 帧几何就是输出几何；主进程据此拼 ffmpeg 的 -s 参数
    fprintf(stderr, "DD-READY %ld %ld\n", rw, rh);
    fflush(stderr);

    _setmode(_fileno(stdout), _O_BINARY);
    ComPtr<ID3D11DeviceContext> ctx;
    device->GetImmediateContext(&ctx);

    const size_t rowBytes = (size_t)rw * 4;
    long frames = 0;
    ComPtr<ID3D11Texture2D> staging;
    D3D11_TEXTURE2D_DESC stagingDesc{};
    for (;;)
    {
        DXGI_OUTDUPL_FRAME_INFO info{};
        ComPtr<IDXGIResource> res;
        hr = dup->AcquireNextFrame(500, &info, &res);
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue; // 静态桌面无新帧：正常
        if (FAILED(hr))
        {
            fprintf(stderr, "[dd-capture] AcquireNextFrame FAILED hr=0x%08lX after %ld frames\n",
                    (unsigned long)hr, frames);
            return 3;
        }
        ComPtr<ID3D11Texture2D> tex;
        hr = res->QueryInterface(IID_PPV_ARGS(&tex));
        if (FAILED(hr)) { dup->ReleaseFrame(); continue; }

        D3D11_TEXTURE2D_DESC td{};
        tex->GetDesc(&td);
        if (!staging || stagingDesc.Width != td.Width || stagingDesc.Height != td.Height || stagingDesc.Format != td.Format)
        {
            stagingDesc = td;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            stagingDesc.BindFlags = 0;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingDesc.MiscFlags = 0;
            staging.Reset();
            hr = device->CreateTexture2D(&stagingDesc, nullptr, &staging);
            if (FAILED(hr)) { dup->ReleaseFrame(); continue; }
        }
        ctx->CopyResource(staging.Get(), tex.Get());
        D3D11_MAPPED_SUBRESOURCE map{};
        hr = ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &map);
        if (FAILED(hr)) { dup->ReleaseFrame(); continue; }
        // 逐行写 stdout：RowPitch 可能大于 w*4，行尾填充不输出
        bool ok = true;
        for (LONG y = 0; y < rh; ++y)
        {
            const BYTE* src = (const BYTE*)map.pData + (size_t)y * map.RowPitch;
            if (fwrite(src, 1, rowBytes, stdout) != rowBytes) { ok = false; break; }
        }
        ctx->Unmap(staging.Get(), 0);
        dup->ReleaseFrame();
        if (!ok)
        {
            fprintf(stderr, "[dd-capture] stdout write failed after %ld frames\n", frames);
            return 4;
        }
        ++frames;
        if (frames % 300 == 0)
            fprintf(stderr, "[dd-capture] frames=%ld\n", frames);
        if (maxFrames >= 0 && frames >= maxFrames) return 0;
    }
}
