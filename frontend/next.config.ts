import type { NextConfig } from "next";

const desktopBuild = process.env.CAFE_ONE_DESKTOP_BUILD === "1";

const nextConfig: NextConfig = {
  ...(desktopBuild ? { output: "export" } : {}),
  env: { NEXT_PUBLIC_CAFE_ONE_API_BASE: desktopBuild ? "" : "http://localhost:8080" },
  allowedDevOrigins: ['192.168.0.169', 'localhost', '127.0.0.1'],
};

export default nextConfig;