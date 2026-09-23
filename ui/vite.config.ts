import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = `http://127.0.0.1:${process.env.FACTORY_PORT ?? 4545}`;
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": daemon, "/health": daemon, "/live": { target: daemon.replace("http", "ws"), ws: true } } },
});
