#!/bin/bash

# Digestを計算
BODY=$(cat test-create.json)
DIGEST=$(echo -n "$BODY" | openssl dgst -sha256 -binary | base64)

# 署名対象文字列を作成
TARGET="post /actors/remydrescarlet/inbox"
HOST="flaxia.app"
DATE=$(date -u +"%a, %d %b %Y %H:%M:%S GMT")

SIGNING_STRING="(request-target): $TARGET
host: $HOST
date: $DATE
digest: SHA-256=$DIGEST"

# 署名
SIGNATURE=$(echo -n "$SIGNING_STRING" | openssl dgst -sha256 -sign test-private.pem | base64 | tr -d '\n' | sed 's/+/-/g; s/\//_/g' | tr -d '=')

# リクエスト送信
curl -X POST https://flaxia.app/actors/remydrescarlet/inbox \
  -H "Content-Type: application/activity+json" \
  -H "Accept: application/activity+json" \
  -H "Date: $DATE" \
  -H "Digest: SHA-256=$DIGEST" \
  -H "Signature: keyId=\"https://test.example.com/actors/testuser#main-key\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date digest\",signature=\"$SIGNATURE\"" \
  -d "$BODY"
