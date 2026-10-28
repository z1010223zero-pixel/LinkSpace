import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@main': r('./src/main') }
    },
    build: {
      outDir: 'out/main',
      // electron 必须保持 external：打进 bundle 后 require('electron')
      // 只会返回可执行文件路径字符串，app 等 API 全部为 undefined
      rollupOptions: { external: ['electron'] },
      lib: {
        entry: r('./src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: { external: ['electron'] },
      lib: {
        entry: r('./src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: r('./src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': r('./src/renderer'),
        '@shared': r('./src/shared')
      }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: r('./src/renderer/index.html')
      }
    }
  }
})
