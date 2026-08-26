# 직원 스케줄러 v16.1 — Firebase 연결 수정

## 수정 이유
v16은 `app.js`가 ES Module이어서 Windows에서 `index.html`을 더블클릭해
`file://`로 실행하면 Chrome/Edge의 로컬 모듈 보안 정책 때문에 JavaScript가
실행되지 않을 수 있었습니다.

증상:
- Firebase 연결 중… 에서 멈춤
- 직원 0명
- 버튼 기능이 실행되지 않음

## v16.1
- `file://` 직접 실행 지원
- GitHub Pages 실행 지원
- Node.js / npm 필요 없음
- Firebase SDK는 Google CDN에서 동적으로 로드
- Firebase SDK 로드 실패 시 계속 '연결 중'에 멈추지 않고 오류 상태 표시
- 기존 모바일 전용 UX 유지
- 기존 Firebase / Firestore 주차별 저장 구조 유지

## 테스트
1. 인터넷이 연결된 상태에서 `index.html` 더블클릭
2. 상단이 `Firebase 연결 준비…` → `Firebase 동기화` 순으로 변하는지 확인
3. 직원 등록 후 새로고침
4. Firebase Console Firestore 데이터에 `scheduler/employees`와
   `scheduleWeeks/YYYY-MM-DD`가 생기는지 확인

## Firestore 규칙
Firebase Console에서 ZIP의 `firestore.rules` 내용이 실제 Rules에 게시되어 있어야 합니다.

Rules가 아직 적용되지 않았다면 v16.1에서는 더 이상 무한 '연결 중'으로 남지 않고
`권한/연결 오류` 같은 상태로 표시됩니다.
