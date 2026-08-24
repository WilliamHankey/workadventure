FROM mcr.microsoft.com/playwright:v1.60.0-noble

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /workspace

COPY . .
RUN npm ci \
    && npm ci --prefix messages \
    && npm run ts-proto --prefix messages \
    && npm run typecheck --workspace=@workadventure/hermes-connector-protocol \
    && npm run typecheck --workspace=@workadventure/agent-platform

ENV NODE_ENV=production
USER pwuser
EXPOSE 3200

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3200/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["npm", "run", "start", "--workspace=@workadventure/agent-platform"]
