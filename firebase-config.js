// Firebase 웹 앱 설정
export const firebaseConfig = {
  apiKey: "AIzaSyCaFeq4Anf4nbT1HxhX9W_ag-1Np4nr8KI",
  authDomain: "staff-scheduler-82408.firebaseapp.com",
  projectId: "staff-scheduler-82408",
  storageBucket: "staff-scheduler-82408.firebasestorage.app",
  messagingSenderId: "259211057546",
  appId: "1:259211057546:web:37185040e11d811a155073"
};

// Spark 무료 요금제 장기 운영용 설정.
export const schedulerCloudConfig = {
  schedulerCollection: "scheduler",
  employeesDocument: "employees",
  weeksCollection: "scheduleWeeks",

  // 현재 주 + 과거 7주만 Firestore에 보관합니다.
  // 미래에 미리 작성한 스케줄은 삭제하지 않습니다.
  retentionWeeks: 8,

  // 연속 편집 시 Firebase 쓰기를 묶어서 처리합니다.
  saveDebounceMs: 900,

  // GitHub Pages 주소가 확정된 뒤 App Check를 설정하세요.
  // APP_CHECK_SETUP.md 절차 완료 전에는 false로 유지하면 됩니다.
  appCheck: {
    enabled: false,
    recaptchaEnterpriseSiteKey: "PASTE_RECAPTCHA_ENTERPRISE_SITE_KEY"
  }
};

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.appId
  );
}
