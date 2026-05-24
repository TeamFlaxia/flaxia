# ローカルテスト用アカウント

## Account 1
- **Email:** test1@example.com
- **Password:** testpass123
- **Username:** testuser1
- **Display Name:** Test User 1

## Account 2
- **Email:** test2@example.com
- **Password:** testpass456
- **Username:** testuser2
- **Display Name:** Test User 2

---

## How to use

Dev server: http://localhost:8787

### Login via API
```sh
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test1@example.com","password":"testpass123"}'
```
