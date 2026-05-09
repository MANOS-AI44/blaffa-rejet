# Image de base avec Playwright + Chromium pré-installé
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Installer les dépendances
COPY package*.json ./
RUN npm install --production

# Copier le code source
COPY . .

# Variables d'environnement
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Démarrage : init DB puis serveur
CMD ["sh", "-c", "node src/scripts/init-db.js && node src/server.js"]
