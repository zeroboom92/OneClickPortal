# 프로젝트 작업 지침

## 기본 원칙

- 사용자에게는 항상 존댓말을 사용합니다.
- 이 프로젝트는 Chrome/Edge의 기존 로그인 세션을 활용하는 Windows 데스크톱 프로토타입입니다.
- 브라우저 로그인 및 인증서 선택은 사용자가 직접 수행합니다.
- 최종 상신 버튼은 자동으로 실행하지 않습니다. 항상 상신 직전 검토 화면에서 멈춥니다.
- DWM 미리보기는 현재 사용하지 않으며 UI와 연결 흐름에서 제거되어 있습니다.
- 공개된 기존 확장 프로그램의 코드를 재사용하거나 개조하지 않습니다.

## 실행 및 검증

```powershell
dotnet run
dotnet build .\BrowserThumbnailPrototype.csproj --configuration Debug
```

현재 .NET 8 Windows Forms 프로젝트이며, Chrome 또는 Edge 창을 찾아 최소화하고 흰색 2행 조작창에서 업무 버튼을 제공합니다. 조작창은 처음에 우측 하단에 표시되며 드래그로 이동할 수 있습니다.

## 현재 상태

- `MainForm.cs`: 가로형 UI, 브라우저 검색, 연결·최소화, 원본 열기, 연결 해제, 업무 버튼 UI
- `SettingsForm.cs`: 시작 실행, 자동 새로고침, 투명도, 버전·저작권 설정 UI
- `Program.cs`: Windows Forms 진입점
- `BrowserThumbnailPrototype.csproj`: .NET 8 Windows Forms 설정
- `README.md`: 실행 방법
- `HANDOFF.md`: 다음 작업 인수인계

복무·출장·기안·품의 버튼은 현재 업무포털의 실제 화면으로 이동하며, 최종 상신·결재 버튼은 자동으로 실행하지 않습니다.
