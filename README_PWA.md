# GitHub Pages 설치형 앱 배포 파일

이 폴더의 파일을 `mkr-games/zescape` 저장소의 배포 브랜치 루트에 그대로 올리면 다음 주소가 iOS·Android 설치형 PWA로 동작합니다.

<https://mkr-games.github.io/zescape/>

## 추가된 파일

- `manifest.webmanifest`: 앱 이름, 실행 주소, 아이콘, 독립 실행 모드
- `sw.js`: 설치·업데이트·기본 오프라인 캐시
- `pwa.js`: 설치 버튼과 iPhone/Android 설치 안내
- `offline.html`: 네트워크 연결 안내 화면
- `icons/`: 플랫폼별 앱 아이콘
- `docs/설치방법.md`: 사용자용 설치 방법

## GitHub에 적용

1. 저장소의 기존 파일을 백업합니다.
2. 이 폴더의 내용 전체를 저장소 루트에 업로드합니다.
3. 변경 내용을 커밋합니다.
4. GitHub Pages 배포가 끝난 뒤 사이트를 새로고침합니다.
5. `https://mkr-games.github.io/zescape/manifest.webmanifest`와 `https://mkr-games.github.io/zescape/sw.js`가 열리는지 확인합니다.

기존 Firebase 프로젝트와 Firestore 데이터 구조는 변경하지 않습니다.

## 방식의 차이

이 결과물은 App Store 또는 Google Play에서 받는 네이티브 앱이 아니라 브라우저에서 설치하는 PWA입니다. 따라서 Apple 서명, Mac, Xcode, Apple Developer 계정과 앱 심사가 필요하지 않습니다. 설치 후에는 홈 화면 아이콘, 독립 실행 화면, 자동 업데이트를 제공하며 지정된 GitHub Pages 사이트로 바로 들어갑니다.

