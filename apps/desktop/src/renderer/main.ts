import { createApp } from 'vue'
import App from './App.vue'
import ReverseStreamView from './components/ReverseStreamView.vue'
import './style.css'

// 平板画面窗口（线 2 W7）：同一份渲染 bundle，靠 hash 路由区分——
// 主窗口是 index.html（无 hash），画面窗口是 index.html#/reverse-stream?...。
// 不另起渲染入口，避免 electron-vite 多入口配置。
if (window.location.hash.startsWith('#/reverse-stream') || window.location.hash.startsWith('#reverse-stream')) {
  createApp(ReverseStreamView).mount('#app')
} else {
  createApp(App).mount('#app')
}
