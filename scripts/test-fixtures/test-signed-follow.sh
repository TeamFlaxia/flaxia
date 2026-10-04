#!/bin/bash

# テスト用の鍵ペアを生成
openssl genrsa -out test-private.pem 2048
openssl rsa -in test-private.pem -pubout -out test-public.pem

# Digestを計算
BODY=$(cat test-follow.json)
DIGEST=$(echo -n "$BODY" | openssl dgst -sha256 -binary | base64)

# 署名対象文字列を作成
# #133: 既定はローカル。本番への live-fire は明示的な環境変数でのみ。
TARGET_HOST="${FLAXIA_TEST_HOST:-localhost:8787}"
TARGET="post /actors/remydrescarlet/inbox"
HOST="$TARGET_HOST"
DATE=$(date -u +"%a, %d %b %Y %H:%M:%S GMT")

SIGNING_STRING="(request-target): $TARGET
host: $HOST
date: $DATE
digest: SHA-256=$DIGEST"

# 署名
SIGNATURE=$(echo -n "$SIGNING_STRING" | openssl dgst -sha256 -sign test-private.pem | base64 | tr -d '\n' | sed 's/+/-/g; s/\//_/g' | tr -d '=')

# リクエスト送信
curl -X POST "http://${TARGET_HOST}/actors/remydrescarlet/inbox" \
  -H "Content-Type: application/activity+json" \
  -H "Accept: application/activity+json" \
  -H "Date: $DATE" \
  -H "Digest: SHA-256=$DIGEST" \
  -H "Signature: keyId=\"https://test.example.com/actors/testuser#main-key\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date digest\",signature=\"$SIGNATURE\"" \
  -d "$BODY"
