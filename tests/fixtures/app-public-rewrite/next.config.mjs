export default {
  async rewrites() {
    return {
      beforeFiles: [{ source: "/before-files/:path*", destination: "/:path*" }],
      afterFiles: [
        { source: "/after-files/:path*", destination: "/:path*" },
        { source: "/chain/:path*", destination: "/missing/:path*" },
        { source: "/missing/:path*", destination: "/:path*" },
        { source: "/img-alias", destination: "/_next/image?url=%2Fpixel.png&w=640&q=75" },
      ],
      fallback: [{ source: "/fallback-files/:path*", destination: "/:path*" }],
    };
  },
};
