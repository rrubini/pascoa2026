# Páscoa Alpha 2026

Sistema de cadastro para a Ação Social de Páscoa do Ministério Alpha.

**Produção:** https://pascoa2026-b8b7a.web.app
**Admin:** https://pascoa2026-b8b7a.web.app/#alpha-admin

---

## Setup inicial

### 1. Pré-requisitos

```bash
node >= 18
npm install -g firebase-tools
firebase login
```

### 2. Instalar dependências

```bash
npm install
```

### 3. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha com as credenciais do Firebase Console:

```bash
cp .env.example .env
```

```
REACT_APP_FIREBASE_API_KEY=
REACT_APP_FIREBASE_AUTH_DOMAIN=
REACT_APP_FIREBASE_PROJECT_ID=
REACT_APP_FIREBASE_STORAGE_BUCKET=
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=
REACT_APP_FIREBASE_APP_ID=
```

### 4. Inicializar documento de vagas no Firestore

No Firebase Console, crie manualmente o documento `config/slots`:

```json
{ "available": 100, "nextRegNumber": 1 }
```

---

## Rodar localmente

```bash
npm start
```

Abre em http://localhost:3000

---

## Deploy

> O build exige mais memória do que o padrão do Node.

```bash
set NODE_OPTIONS=--max-old-space-size=4096 && npm run build && firebase deploy --project pascoa2026-b8b7a
```

Só regras do Firestore:

```bash
firebase deploy --only firestore:rules --project pascoa2026-b8b7a
```

---

## Estrutura Firestore

| Coleção | Descrição |
|---|---|
| `config/slots` | Vagas disponíveis e contador de inscrições |
| `reservations/{sid}` | Reservas temporárias (expiram em 5 min) |
| `registrations/{regId}` | Cadastros confirmados |
| `waitlist/{id}` | Lista de espera |
| `bypass_tokens/{token}` | Links de acesso para promovidos da espera |

---

## Configurações relevantes (`src/App.js`)

```js
CFG.MAX_SLOTS        // total de vagas (padrão: 100)
CFG.TIMER_SEC        // tempo de reserva em segundos (padrão: 300)
CFG.ADMIN_PWD        // senha do painel admin
CFG.ADMIN_HASH       // hash da rota admin (padrão: #alpha-admin)
CFG.EVENT_DATE_LABEL // data exibida no app e no PDF
CFG.OPEN_AT          // data/hora de abertura das inscrições
```
