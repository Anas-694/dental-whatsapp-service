# DentalCare WhatsApp Service

WhatsApp microservice for DentalCare Pro using Baileys.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `AUTH_TOKEN` | Secret token for API auth |
| `PORT` | Server port (default: 3001) |

## API Endpoints

| Method | Route | Description |
|---|---|---|
| GET | /health | Health check |
| GET | /api/status | Connection status |
| GET | /api/qr | Get QR code |
| POST | /api/send | Send message |
| POST | /api/disconnect | Logout |
| POST | /api/restart | Generate new QR |
