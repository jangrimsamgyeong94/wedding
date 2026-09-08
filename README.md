# Wedding Pose Atlas

## 내 컴퓨터에서 보기

1. 이 저장소 폴더에서 `npm run dev`를 실행합니다.
2. 터미널에 표시되는 `http://127.0.0.1:4173` 주소를 엽니다.
3. 아래 폴더에 사진을 추가하거나 삭제하면 브라우저가 자동으로 새로고침됩니다.

- `images/man` — 남자 솔로
- `images/women` — 여자 솔로
- `images/couple` — 함께
- `images/outdoor` — 야외

지원 형식은 JPG, JPEG, PNG, WEBP, GIF, AVIF입니다. 파일명은 자유롭게 사용할 수 있습니다.

`index.html`을 파일 탐색기에서 직접 열면 브라우저 보안 때문에 폴더 목록을 읽을 수 없습니다. 폴더 자동 반영이 필요할 때는 위의 개발 서버를 사용하세요.

## GitHub Pages 반영

사진을 추가·삭제한 뒤 커밋하고 `main` 브랜치에 푸시하면 GitHub Actions가 이미지 목록과 캐시 버전을 자동 생성해 Pages에 배포합니다. `index.html`이나 `images/manifest.json`을 직접 수정할 필요는 없습니다.
