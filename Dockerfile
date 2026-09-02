# Playwright's own image ships Chromium + all required OS-level dependencies,
# which avoids the usual "missing shared libs" headaches on Debian/Ubuntu-based PaaS hosts.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Safety net: makes sure the Chromium build matches whatever Playwright version
# npm actually resolved, even if it drifts slightly from the base image's version.
RUN npx playwright install --with-deps chromium

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
