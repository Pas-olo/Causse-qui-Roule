FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY . .
# Polices auto-hébergées (si le téléchargement échoue, le site utilise les polices système)
RUN node scripts/fetch-fonts.mjs || true
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=1m --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node","--disable-warning=ExperimentalWarning","server.js"]
