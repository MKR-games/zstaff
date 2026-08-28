(() => {
  const installButtons = [...document.querySelectorAll("[data-install-app]")];
  const installDialog = document.querySelector("#pwaInstallDialog");
  const installCopy = document.querySelector("#pwaInstallCopy");
  let deferredPrompt = null;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  function setInstallButtonVisibility(visible) {
    installButtons.forEach((button) => button.classList.toggle("hidden", !visible));
  }

  function instructionMarkup() {
    if (isIOS) {
      return `
        <p>Safari에서 아래 순서대로 누르면 홈 화면에 앱이 설치됩니다.</p>
        <ol>
          <li>화면 아래의 <strong>공유</strong> 버튼을 누릅니다.</li>
          <li><strong>홈 화면에 추가</strong>를 선택합니다.</li>
          <li>오른쪽 위의 <strong>추가</strong>를 누릅니다.</li>
        </ol>
        <p class="pwa-install-note">설치된 아이콘을 누르면 주소창 없이 직원 스케줄러가 바로 열립니다.</p>
      `;
    }

    return `
      <p>브라우저 메뉴에서 아래 순서대로 설치할 수 있습니다.</p>
      <ol>
        <li>오른쪽 위의 <strong>⋮ 메뉴</strong>를 누릅니다.</li>
        <li><strong>앱 설치</strong> 또는 <strong>홈 화면에 추가</strong>를 선택합니다.</li>
        <li><strong>설치</strong>를 누릅니다.</li>
      </ol>
      <p class="pwa-install-note">설치된 아이콘을 누르면 직원 스케줄러가 독립된 앱 화면으로 열립니다.</p>
    `;
  }

  function showInstallInstructions() {
    if (!installDialog || !installCopy) return;
    installCopy.innerHTML = instructionMarkup();
    if (typeof installDialog.showModal === "function") {
      installDialog.showModal();
    }
  }

  async function requestInstall() {
    if (isStandalone()) return;

    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      setInstallButtonVisibility(false);
      return;
    }

    showInstallInstructions();
  }

  installButtons.forEach((button) => {
    button.addEventListener("click", requestInstall);
  });

  document.querySelectorAll("[data-close-install-dialog]").forEach((button) => {
    button.addEventListener("click", () => installDialog?.close());
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    setInstallButtonVisibility(!isStandalone());
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    setInstallButtonVisibility(false);
  });

  window.matchMedia("(display-mode: standalone)").addEventListener?.("change", () => {
    setInstallButtonVisibility(!isStandalone());
  });

  setInstallButtonVisibility(!isStandalone());

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" })
        .catch((error) => console.error("PWA service worker registration failed:", error));
    }, { once: true });
  }
})();
