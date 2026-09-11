# 세션 안정성 독립 검증 보고서

작성일: 2026-09-11
검증자: terra (독립 검증), astra (최종 검토)
기준: `476534759aa66f6063f84fa6cb01922e46f0f8d1` 이후 최종 작업 트리
대상 산출물: `bin\\Debug\\net8.0-windows\\OneClickPortal.dll`, `bin\\Release\\net8.0-windows\\OneClickPortal.dll`, `publish-test-1.0.3-sessionfix-20260911-r3\\OneClickPortal.exe`

## 최종 판정: 코드 자동 검증 통과, 실환경 검증 전 배포 보류

sol 수정본은 기준선의 여러 결함을 해결했고 V4의 실제 Nexacro JSON transaction fixture, Debug/Release 빌드와 VM 회귀 테스트를 통과했다. V3→V4 전환도 재검토했으며 자동 범위에서 배포를 막을 코드 결함을 발견하지 못했다. 다만 아래 실환경 증거가 없으므로 작업지시서의 배포 기준에는 도달하지 못했다.

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
| Node 회귀 테스트 | 35개 통과, 실패 0개. V4의 실제 JSON transaction·`_gfnCallback` fixture와 wrapper 복원, V3 pending/stale/recovery/`OWNERSHIP_UNCONFIRMED` 차단, 확정 V3 Y/N 이관 및 V3 부재 시 V2 처리를 포함한다. |
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
| 에듀파인 stale·소유권 | 자동 통과 / 일회 실환경 통과 | V4는 실제 `gfnTransaction` JSON의 `svcId=sessionCheck`를 보존하며 form/request metadata만 추가하고, `_gfnCallback` context를 통해 owned callback만 상태·타이머를 변경한다. 원본 `gfnCallback`/`fnCallback` 계약과 임시 `transaction` 복원은 fixture에서 통과했다. V3 pending/stale/recovery/`OWNERSHIP_UNCONFIRMED`는 V4 전송을 0건으로 차단하고, 확정 Y/N·오류만 한 번 이관한다. V3이 없을 때만 V2를 처리한다. 실제 로그인 탭 직접 적용에서 `STARTED → Y`를 확인했고, r3 실행 파일로 재시작·연결한 뒤 09:05:55 `STARTED`, 09:06:55 공식 callback `Y`가 기록됐다. 같은 주기에 업무포털 HTTP 성공과 나이스 최근 `Y`도 확인됐으며 경고창은 다시 생성되지 않았다. 장시간 반복은 미검증이다. |
| 로그 정확성 | 부분 통과 | 나이스는 timeout/abort/HTTP/network/auth 응답을 분리하고, 포털·에듀파인은 복구 필요를 사용자 메시지로 전달한다. 실제 서버 오류·로그아웃 HTML·타이머 초기화 실패를 관찰한 로그 증거는 아직 없다. |

## 확인한 핵심 근거

- [SystemSleepGuard.cs](C:/Users/user/Desktop/원클릭업무포털/원클릭업무포털/SystemSleepGuard.cs)는 공식 `REASON_CONTEXT`의 `Detailed` 구조체와 simple-string union을 사용한다. Microsoft의 [REASON_CONTEXT 정의](https://learn.microsoft.com/ko-kr/windows/win32/api/minwinbase/ns-minwinbase-reason_context)와 대조했다.
- [MainForm.cs](C:/Users/user/Desktop/원클릭업무포털/원클릭업무포털/MainForm.cs)는 점검 결과가 현재 연결 세대에 속할 때만 상태를 반영하고, 점검 gate 해제 뒤 modeless notice를 표시한다.
- [PortalWorkflowController.cs](C:/Users/user/Desktop/원클릭업무포털/원클릭업무포털/PortalWorkflowController.cs)의 나이스 V3는 V2 in-flight를 먼저 관찰하고 V3 요청 ID로 자체 callback 소유권을 보호한다.
- 같은 파일의 에듀파인 V4는 JSON service object에 metadata를 추가하고 `_gfnCallback`에서 context로 전달하므로 framework의 `svcId=sessionCheck` special-case를 보존한다. V3의 미확정 상태는 recovery 필요로 차단하고, V3의 확정 결과만 이관한 뒤 V2를 건너뛴다.

## 배포 전 필수 조치

1. 현재 탭에 V3 `OWNERSHIP_UNCONFIRMED` 또는 V3 recovery 상태가 남아 있으면 자동 재전송하지 않는다. 해당 K-에듀파인 탭을 **새로고침한 뒤** 다시 연결하거나 재로그인해 새 V4 상태를 시작한다. C#은 이를 `LEGACY_V3_RECOVERY_REQUIRED` 실패로 매핑해 자동 전송을 중단한다. 현재 안내 문구의 “화면 확인 또는 다시 로그인”은 이 새로고침/재로그인을 의미한다.
2. 수정 테스트 빌드에서 업무포털 HTTP 200 뒤 서버 세션이 공식 제한 시간을 넘어 유지되는지 확인한다.
3. 관리자 권한 환경에서 실행 전·실행 중·종료 후 `powercfg /requests`를 기록해 SYSTEM만 나타나고 종료 뒤 사라지는지 확인한다.
4. `publish-test-1.0.3-sessionfix-20260911-r3\\OneClickPortal.exe`를 사용해 최소 90분 동안 업무포털·나이스·K-에듀파인을 관찰한다. 브라우저 최소화, 사용자 허용 시 화면 잠금/복귀, 알림 미닫음 3주기, 특정 시스템 만료 뒤 나머지 감시 지속을 포함한다. 개인정보·쿠키·토큰·업무 내용은 기록하지 않는다.

테스트 실행 파일 식별 정보:

- 표시 버전: `1.0.3-sessionfix.20260911.r3`
- 파일 버전: `1.0.3.0`
- SHA-256: `0DB07BAEB2658BF3C641319210C75F3CF59E11DBCBBF103FF60AF4B23908AC7B`

위 조치가 끝나기 전에는 수정본을 배포하거나 세션 유지가 해결됐다고 보고하면 안 된다.
