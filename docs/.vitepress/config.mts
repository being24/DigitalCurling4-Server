import { defineConfig } from "vitepress";

export default defineConfig({
  title: "DigitalCurling4-Server",
  description: "Cloudflare Workers版DigitalCurling4サーバーのドキュメント",
  lang: "ja",
  base: "/DigitalCurling4-Server/",
  themeConfig: {
    nav: [
      { text: "ガイド", link: "/guide/getting-started" },
      { text: "APIリファレンス", link: "/api/rest" },
    ],
    sidebar: [
      {
        text: "ガイド",
        items: [
          { text: "セットアップ・利用ガイド", link: "/guide/getting-started" },
          { text: "アーキテクチャ", link: "/guide/architecture" },
        ],
      },
      {
        text: "APIリファレンス",
        items: [
          { text: "REST API", link: "/api/rest" },
          { text: "WebSocket/SSEプロトコル", link: "/api/protocol" },
        ],
      },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/being24/DigitalCurling4-Server",
      },
    ],
    search: {
      provider: "local",
    },
  },
});
