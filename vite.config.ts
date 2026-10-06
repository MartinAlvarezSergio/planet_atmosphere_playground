import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/planet_atmosphere_playground/",
  plugins: [react()]
});
