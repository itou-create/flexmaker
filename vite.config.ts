import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// GitHub Pages のサブディレクトリに置く場合は base を '/<repo名>/' にする。
// 例: https://user.github.io/flexmaker/ に置くなら base: '/flexmaker/'
export default defineConfig({
  base: './',
  server: {
    // スマホ確認用に Cloudflare Quick Tunnel（cloudflared tunnel --url http://localhost:5173）経由でも開けるようにする
    allowedHosts: ['.trycloudflare.com'],
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // OneDrive 配下では Vite が dist/ を空にする処理で Node がクラッシュする（Node 24 で確認）。
    // 自前で消してから build する。古い assets が残るので、公開前に dist/assets を消すこと。
    emptyOutDir: false,
    rollupOptions: {
      input: {
        // 担当者の作成画面と、住民向け確認ページの2ページ構成
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        check: fileURLToPath(new URL('./check.html', import.meta.url)),
      },
    },
  },
})
