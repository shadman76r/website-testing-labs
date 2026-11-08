FROM mcr.microsoft.com/playwright:v1.65.0-noble AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run typecheck
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.65.0-noble AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app /app
RUN chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 3000
CMD ["npm", "run", "start"]
