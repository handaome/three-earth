import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/tdt": {
        target: "https://t0.tianditu.gov.cn",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/tdt/, "")
      }
    }
  }
});
