# 세션 안정성 독립 검증 보고서

작성일: 2026-09-10  
검증자: terra (독립 검증), astra (최종 검토)  
기준: `476534759aa66f6063f84fa6cb01922e46f0f8d1` 이후 최종 작업 트리  
대상 산출물: `bin\\Debug\\net8.0-windows\\OneClickPortal.dll`, `bin\\Release\\net8.0-windows\\OneClickPortal.dll`, `publish-test-1.0.3-sessionfix-20260910-r2\\OneClickPortal.exe`

## 최종 판정: 코드 자동 검증 통과, 실환경 검증 전 배포 보류

sol 수정본은 기준선의 여러 결함을 해결했고 정적·VM 회귀 테스트와 Debug/Release 빌드를 통과했다. 재검토한 정적·자동 범위에는 더 이상 배포를 막을 코드 결함을 발견하지 못했다. 다만 아래 실환경 증거가 없으므로 작업지시서의 배포 기준에는 도달하지 못했다.

1. 주 담당자가 로그인된 업무포털에서 `세션 시간 초기화` 버튼의 jQuery click handler가 `/bpm_lgn_lg00_102.do`에 POST하고, 실제 버튼 클릭 뒤 같은 요청이 HTTP 200으로 끝나는 것을 확인했다. 이 관찰은 선택자·엔드포인트·일회 HTTP 성공을 뒷받침하지만 서버 세션이 공식 제한 시간을 넘어 유지되는지는 아직 확인하지 못했다. 실제 SYSTEM 전원 요청 및 종료 후 해제, 세 시스템 90분 관찰도 미검증이다.

따라서 자동 검증 결과는 **통과**, 배포 가능 여부는 **실환경 검증 완료까지 보류**다.

## 실행 결과

```powershell
git diff --check
dotnet build .\\BrowserThumbnailPrototype.csproj --configuration Debug
dotnet build .\\BrowserThumbnailPrototype.csproj --configuration Release
node --test tests/*.test.mjs
powercfg /requests
```

| 검증 | 결과 |
| --- | --- |
| `git diff --check` | 통과. 공백 오류 없음. Git이 CRLF 변환 경고를 출력했으나 diff 오류는 아니다. |
| Debug 빌드 | 통과. 경고 0개, 오류 0개. |
| Release 빌드 | 통과. 경고 0개, 오류 0개. |
| Node 회귀 테스트 | 29개 통과, 실패 0개. 새 테스트는 전원 정의, 포털 요청 완료 추적, MainForm 격리, 나이스 V2 상태, 에듀파인 stale·거래 식별자·교체 전 화면 콜백, 원본 `fnCallback` 전달 및 다른 서비스 callback 격리를 포함한다. |
| `powercfg /requests` | 미검증. 현재 세션은 관리자 권한이 없어 요청 목록을 조회할 수 없었다. API 반환값 또는 앱 로그만으로 통과 처리하지 않는다. |

## 항목별 독립 검토

| 영역 | 판정 | 검토 결과 |
| --- | --- | --- |
| SYSTEM 전원 요청 | 자동 통과 / 실환경 미검증 | `SystemRequired=1`로 명시했고 `PowerSetRequest`/`PowerClearRequest` 모두 같은 enum을 사용한다. `SafeFileHandle`, lock, 중복 시작·반복 Dispose 보호, 생성/설정/해제 실패 로그가 있다. `REASON_CONTEXT`는 공식 `Detailed`/`SimpleReasonString` union과 일치하며 x64 32바이트, x86 24바이트를 확인한다. 실제 OS가 SYSTEM 요청을 등록·해제하는지는 아직 확인하지 못했다. |
| 전원 수명 | 코드 검토 통과 / 실환경 미검증 | 앱 생성 시 연결·최소화·포커스와 무관하게 요청하고 `FormClosing`에서 해제한다. 전원 계획 변경 코드는 없다. 잠금·수동 절전·Modern Standby에서의 실제 동작은 미검증이다. |
| 업무포털 상태 판정 | 부분 통과 | `LOADING`은 Pending, 숨은 frame은 로그아웃 근거에서 제외하며, 버튼 부재와 jQuery 부재는 Failed로 처리한다. 기존처럼 미확인을 Healthy로 반환하지 않는다. |
| 업무포털 공식 연장 | 일회 동작 확인 / 장시간 미검증 | 로그인된 실제 화면에서 가시적 `button.btn.btn-refresh[title="세션 시간 초기화"]`의 jQuery handler, `/bpm_lgn_lg00_102.do` POST 및 버튼 클릭 뒤 HTTP 200을 주 담당자가 확인했다. 코드는 ajaxComplete의 2xx만 성공으로 취급하고 pending/stale 중 재클릭을 막는다. 이 수정본으로 서버 세션이 공식 제한 시간을 넘어 유지되는지는 아직 확인하지 못했다. |
| 비모달 알림·gate | 코드/정적 테스트 통과 | 백그라운드 확인은 `finally`에서 gate를 해제한 뒤 `ShowSessionNotice`로 modeless Form을 표시한다. `MessageBox.Show`는 그 경로에서 제거됐다. 알림을 닫지 않고 실제 3주기 이상 감시가 계속되는 실행 검증은 남아 있다. |
| 업무 실행 격리·재개 | 코드/정적 테스트 통과 | 업무 실행의 세션 만료 처리에서 `DisconnectBrowser()`를 제거했다. 만료 시스템만 pending owner로 저장하고 같은 시스템의 Healthy 확인 후 한 번만 재개한다. 실제 나이스 만료 상태에서 업무포털·에듀파인 감시 지속은 아직 실행 검증하지 못했다. |
| 연결 세대 경쟁 | 코드 검토 통과 / 실행 미검증 | 연결·해제에서 generation을 변경하고, 점검 완료 시 캡처한 generation/port/window가 현재 연결과 같은지 확인해 이전 결과를 폐기한다. `CancellationTokenSource` 정리는 참조 동일성 확인 뒤 수행한다. 의도적으로 지연시킨 실제 DevTools 응답과 재연결/종료 교차 테스트는 없다. |
| 나이스 V2→V3 공유 | VM 통과 / 실환경 미검증 | V2 pending은 `LEGACY_IN_FLIGHT`로 차단하고 V2 완료 Y/N은 V3 상태로 한 번 복사한다. V2 stale도 새 요청 없이 차단한다. 요청 ID로 V3의 늦은 콜백이 새 V3 요청을 덮지 못하게 했고, callbacks 배열·context·콜백 예외를 VM 테스트했다. 실제 jQuery 버전과 V2 래퍼가 이 계약을 만족하는지는 미검증이다. |
| 에듀파인 stale·소유권 | 자동 통과 / 실환경 미검증 | V3 transaction `svcID` 태그, request ID, form token으로 늦은 이전 callback·중복 callback·교체 전 topForm이 새 요청 상태나 타이머를 바꾸지 않게 했고 VM 테스트도 통과했다. owned callback만 OneClick 상태와 타이머를 변경하며, owned/non-owned 태그 callback은 base original에 복원된 `sessionCheck` 인자로 한 번 전달한다. 태그 없는 `sessionCheck`는 previous chain으로, 다른 서비스는 base original로 한 번 전달한다. 다른 서비스 ID의 직접 VM 테스트는 남아 있다. |
| 로그 정확성 | 부분 통과 | 나이스는 timeout/abort/HTTP/network/auth 응답을 분리하고, 포털·에듀파인은 복구 필요를 사용자 메시지로 전달한다. 실제 서버 오류·로그아웃 HTML·타이머 초기화 실패를 관찰한 로그 증거는 아직 없다. |

## 확인한 핵심 근거

- [SystemSleepGuard.cs](C:/Users/user/Desktop/원클릭업무포털/원클릭업무포털/SystemSleepGuard.cs)는 공식 `REASON_CONTEXT`의 `Detailed` 구조체와 simple-string union을 사용한다. Microsoft의 [REASON_CONTEXT 정의](https://learn.microsoft.com/ko-kr/windows/win32/api/minwinbase/ns-minwinbase-reason_context)와 대조했다.
- [MainForm.cs](C:/Users/user/Desktop/원클릭업무포털/원클릭업무포털/MainForm.cs)는 점검 결과가 현재 연결 세대에 속할 때만 상태를 반영하고, 점검 gate 해제 뒤 modeless notice를 표시한다.
- [PortalWorkflowController.cs](C:/Users/user/Desktop/원클릭업무포털/원클릭업무포털/PortalWorkflowController.cs)의 나이스 V3는 V2 in-flight를 먼저 관찰하고 V3 요청 ID로 자체 callback 소유권을 보호한다.
- 같은 파일의 에듀파인 V3는 transaction `svcID` 태그와 form token으로 상태 변경 소유권을 확인한다. owned 여부와 무관하게 태그 callback은 base original에 `sessionCheck`로 복원해 전달하고, 태그 없는 `sessionCheck`는 previous chain으로 전달한다. VM 테스트가 늦은·중복·교체 전 callback과 ownership-unconfirmed의 원본 전달을 확인한다.

## 배포 전 필수 조치

1. 수정 테스트 빌드에서 업무포털 HTTP 200 뒤 서버 세션이 공식 제한 시간을 넘어 유지되는지 확인한다.
2. 관리자 권한 환경에서 실행 전·실행 중·종료 후 `powercfg /requests`를 기록해 SYSTEM만 나타나고 종료 뒤 사라지는지 확인한다.
3. `publish-test-1.0.3-sessionfix-20260910-r2\\OneClickPortal.exe`를 사용해 최소 90분 동안 업무포털·나이스·K-에듀파인을 관찰한다. 브라우저 최소화, 사용자 허용 시 화면 잠금/복귀, 알림 미닫음 3주기, 특정 시스템 만료 뒤 나머지 감시 지속을 포함한다. 개인정보·쿠키·토큰·업무 내용은 기록하지 않는다.

테스트 실행 파일 식별 정보:

- 표시 버전: `1.0.3-sessionfix.20260910.r2`
- 파일 버전: `1.0.3.0`
- SHA-256: `DF5E1D515D50B2843AC270ACA757E42123355DD5475E51C0712DD36B0A416B9E`

위 조치가 끝나기 전에는 수정본을 배포하거나 세션 유지가 해결됐다고 보고하면 안 된다.
