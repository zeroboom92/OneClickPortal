# 원클릭업무포털

로그인된 Edge 세션을 이용해 나이스와 K-에듀파인의 업무 입력 화면까지 이동하는 Windows 데스크톱 프로그램입니다.

## 설치

GitHub의 **Releases**에서 최신 `Setup.exe`를 내려받아 설치합니다.

설치형 프로그램은 시작할 때 GitHub Release의 새 버전을 확인합니다. 새 버전이 있으면 자동으로 다운로드하고 적용한 뒤 다시 실행합니다.

## 사용 순서

1. 프로그램에서 `로그인`을 누릅니다.
2. 열린 Edge에서 업무포털 로그인과 인증서 인증을 직접 완료합니다.
3. 프로그램에서 해당 Edge 창을 선택하고 `연결`을 누릅니다.
4. `나이스`, `복무`, `출장`, `에듀파인`, `기안`, `품의` 버튼으로 필요한 화면을 엽니다.
5. 내용을 확인하고 입력한 뒤 최종 상신 또는 결재 요청은 사용자가 직접 실행합니다.

## 안전 원칙

- 로그인과 인증서 선택은 사용자가 직접 수행합니다.
- 프로그램은 최종 상신·결재 요청 버튼을 자동으로 누르지 않습니다.
- 로그인 정보, 인증서 암호, 개인정보와 세션 토큰을 저장하지 않습니다.

## 개발 실행

```powershell
dotnet run
```

## 빌드

```powershell
dotnet build .\BrowserThumbnailPrototype.csproj --configuration Debug
```

## 로그

```text
%LOCALAPPDATA%\OneClickPortal\logs
```

## 저작권

원클릭업무포털, 청완초등학교 온영범. All rights reserved.
