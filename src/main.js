
(() => {
      "use strict";

      const STORAGE_KEY = "daylight.tasks.v1";
      const SETTINGS_KEY = "daylight.settings.v1";
      const REMINDER_COUNTS = { 1: 3, 2: 3, 3: 4, 4: 5, 5: 7 };
      const $ = (selector) => document.querySelector(selector);
      const activeList = $("#active-list");
      const completedList = $("#completed-list");
      const taskInput = $("#task-input");
      const dialog = $("#edit-dialog");
      const authDialog = $("#auth-dialog");
      const profileDialog = $("#profile-dialog");
      let selectedPriority = 5;
      let editingId = null;
      let clerk = null;
      let clerkInitError = null;
      let currentUser = null;
      let currentProfile = null;
      let cloudReady = false;
      let cloudWriteQueue = Promise.resolve();
      let cloudUpdatedAt = 0;
      let cloudWriteInProgress = false;
      let localDataRevision = 0;
      let cloudPollTimer = null;
      let authStateSequence = 0;
      let bootstrappingUserId = null;
      let mountedAuthMode = null;
      let creatingAccount = false;
      let selectedPhoto = null;
      let tasks = loadTasks();
      let settings = loadSettings();

      function normalizeTasks(value) {
        if (!Array.isArray(value)) return [];
        return value.filter((task) => task && typeof task.id === "string" && typeof task.title === "string")
          .map((task) => ({
            id: task.id, title: task.title.slice(0, 120),
            priority: Math.min(5, Math.max(1, Number(task.priority) || 1)),
            completed: Boolean(task.completed), createdAt: Number(task.createdAt) || Date.now(),
            completedAt: Number(task.completedAt) || null
          }));
      }

      function loadTasks(key = STORAGE_KEY) {
        try {
          return normalizeTasks(JSON.parse(localStorage.getItem(key) || "[]"));
        } catch (error) {
          console.error("Could not read saved tasks:", error);
          return [];
        }
      }

      function normalizeSettings(saved) {
        const defaults = { paused: false, start: "08:00", end: "22:00", sent: {} };
        if (!saved || typeof saved !== "object") return defaults;
        return {
          ...defaults, ...saved,
          start: /^\d{2}:\d{2}$/.test(saved.start) ? saved.start : defaults.start,
          end: /^\d{2}:\d{2}$/.test(saved.end) ? saved.end : defaults.end,
          sent: saved.sent && typeof saved.sent === "object" ? saved.sent : {}
        };
      }

      function loadSettings(key = SETTINGS_KEY) {
        try {
          const saved = JSON.parse(localStorage.getItem(key) || "{}");
          return normalizeSettings(saved);
        } catch (error) {
          console.error("Could not read reminder settings:", error);
          return normalizeSettings(null);
        }
      }

      function localStorageKey(key) {
        return currentUser ? `${key}.${currentUser.dataId || currentUser.uid}` : key;
      }
      function saveLocalData() {
        try {
          localStorage.setItem(localStorageKey(STORAGE_KEY), JSON.stringify(tasks));
          localStorage.setItem(localStorageKey(SETTINGS_KEY), JSON.stringify(settings));
        } catch (error) {
          console.error("Could not save local task data:", error);
          showToast("Your changes could not be saved on this device.");
        }
      }
      function saveCloudData() {
        if (!cloudReady || !currentUser) return;
        const userId = currentUser.uid;
        const userData = JSON.parse(JSON.stringify({ tasks, settings }));
        cloudWriteQueue = cloudWriteQueue.then(async () => {
          if (!cloudReady || currentUser?.uid !== userId) return;
          cloudWriteInProgress = true;
          try {
            const result = await authenticatedRequest("/api/data", {
              method: "PUT",
              body: JSON.stringify(userData)
            });
            cloudUpdatedAt = result.updatedAt || cloudUpdatedAt;
          } finally {
            cloudWriteInProgress = false;
          }
        }).catch((error) => {
          console.error("Could not sync task data:", error);
          if (currentUser?.uid === userId) showToast("Your changes could not be synced to your account. Check your connection.");
        });
      }

      function persistTasks() {
        localDataRevision += 1;
        saveLocalData();
        saveCloudData();
      }
      function persistSettings() {
        persistTasks();
      }
      function escapeHtml(value) {
        return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      }
      function makeId() {
        return window.crypto && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      }
      function showToast(message) {
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = message;
        $("#toast-region").append(toast);
        window.setTimeout(() => toast.remove(), 3500);
      }

      function taskMarkup(task) {
        const stars = "★".repeat(task.priority) + "☆".repeat(5 - task.priority);
        return `<article class="task-card${task.completed ? " done" : ""}" data-id="${escapeHtml(task.id)}">
          <button class="task-check" data-action="toggle" aria-label="${task.completed ? "Restore" : "End"} task: ${escapeHtml(task.title)}" title="${task.completed ? "Restore task" : "End task"}">${task.completed ? '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Restore' : '<span aria-hidden="true">○</span>End Task'}</button>
          <div class="task-body"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta"><span class="task-stars" aria-label="${task.priority} of 5 stars" title="Importance: ${task.priority} of 5">${stars}</span><span class="reminder-count"><svg viewBox="0 0 24 24" fill="none"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>${REMINDER_COUNTS[task.priority]} reminders/day</span></div></div>
          <div class="task-actions">${task.completed ? "" : `<button class="mini-button" data-action="edit" aria-label="Edit ${escapeHtml(task.title)}" title="Edit task"><svg viewBox="0 0 24 24" fill="none"><path d="m14 5 5 5M4 20l4.3-1 10.4-10.4a2.1 2.1 0 0 0-3-3L5.3 16 4 20Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`}
          <button class="mini-button delete" data-action="delete" aria-label="Delete ${escapeHtml(task.title)}" title="Delete task"><svg viewBox="0 0 24 24" fill="none"><path d="M4.5 7h15m-13.5 0 1 13h10l1-13M9 7V4h6v3m-5 4v5m4-5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
        </article>`;
      }

      function render() {
        const active = tasks.filter((task) => !task.completed).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
        const completed = tasks.filter((task) => task.completed).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
        activeList.innerHTML = active.length ? active.map(taskMarkup).join("") :
          `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M7 4h10a2 2 0 0 1 2 2v14l-7-4-7 4V6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 9h6m-6 3h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div><strong>Nothing on your list just yet</strong><p>Add a task above and give your day a little direction.</p></div>`;
        completedList.innerHTML = completed.length ? completed.map(taskMarkup).join("") :
          `<div class="empty-state" style="padding:17px 10px"><p>Your finished tasks will find a home here.</p></div>`;
        const total = tasks.length;
        const done = completed.length;
        const percent = total ? Math.round((done / total) * 100) : 0;
        $("#total-count").textContent = total;
        $("#completed-count").textContent = done;
        $("#pending-count").textContent = active.length;
        $("#completion-percent").textContent = `${percent}%`;
        $("#progress-fill").style.width = `${percent}%`;
        $("#progress-caption").textContent = total ? `${done} of ${total} tasks completed` : "A great day starts with one task";
        $("#active-badge").textContent = `${active.length} active`;
        $("#completed-section-count").textContent = `(${done})`;
        $("#clear-completed").hidden = !done;
        $("#pause-reminders").checked = settings.paused;
        $("#wake-start").value = settings.start;
        $("#wake-end").value = settings.end;
        updatePermissionUI();
        updateAccountUI();
      }

      function putAvatar(element, profile) {
        element.replaceChildren();
        if (profile && profile.photoURL) {
          const image = document.createElement("img");
          image.src = profile.photoURL;
          image.alt = "";
          element.append(image);
        } else {
          element.textContent = (profile?.nickname || "Y").trim().charAt(0).toUpperCase() || "Y";
        }
      }

      function updateAccountUI() {
        const label = $("#account-label");
        const accountButton = $("#account-button");
        const sidebarAvatar = $("#sidebar-avatar");
        if (currentUser) {
          const nickname = currentProfile?.nickname || currentUser.displayName || currentUser.email || "Your account";
          label.textContent = nickname;
          accountButton.setAttribute("aria-label", `Manage account for ${nickname}`);
          $("#sidebar-nickname").textContent = nickname;
          $("#sidebar-email").textContent = currentUser.email || "Signed in";
          putAvatar($("#account-avatar"), currentProfile);
          putAvatar(sidebarAvatar, currentProfile);
        } else {
          label.textContent = "Sign in";
          accountButton.setAttribute("aria-label", "Sign in or manage account");
          $("#sidebar-nickname").textContent = "Your workspace";
          $("#sidebar-email").textContent = "Personal space";
          putAvatar($("#account-avatar"), null);
          putAvatar(sidebarAvatar, null);
        }
      }

      function updatePermissionUI() {
        const note = $("#permission-note");
        const button = $("#enable-notifications");
        if (!("Notification" in window)) {
          note.className = "permission-note warning";
          note.textContent = "This browser does not support notifications. Your task list still works, but browser reminders aren't available here.";
          button.disabled = true;
          button.textContent = "Notifications unavailable";
          return;
        }
        button.disabled = false;
        if (Notification.permission === "granted") {
          note.className = "permission-note success";
          note.textContent = settings.paused ? "Permission is on. Reminders are paused until you resume them." : "Notifications are enabled. Reminders will arrive during your selected day.";
          button.textContent = "Notifications Enabled";
        } else if (Notification.permission === "denied") {
          note.className = "permission-note warning";
          note.textContent = "Notifications are blocked. To enable them, open this site's browser or device notification settings, allow notifications, then reload this page.";
          button.textContent = "Permission blocked";
        } else {
          note.className = "permission-note";
          note.textContent = "Reminders are off. Enable browser notifications when you're ready.";
          button.textContent = "Enable Notifications";
        }
      }

      function defaultProfile(user) {
        const emailName = (user.email || "daylight").split("@")[0]
          .toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 14) || "daylight";
        return {
          username: `user_${user.uid.slice(0, 8)}`,
          nickname: user.displayName || emailName,
          photoURL: user.photoURL || null,
          email: user.email || ""
        };
      }

      async function authenticatedRequest(path, options = {}) {
        if (!clerk?.session) throw new Error("Sign in to sync your account data.");
        const token = await clerk.session.getToken();
        if (!token) throw new Error("Your session expired. Please sign in again.");
        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${token}`);
        if (options.body && !(options.body instanceof FormData)) {
          headers.set("Content-Type", "application/json");
        }
        const response = await fetch(path, { ...options, headers });
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error("Daylight’s account service returned an unreadable response.");
        }
        if (!response.ok) {
          throw new Error(result.error || "The request could not be completed. Please try again.");
        }
        return result;
      }

      function clerkUserProfile(user) {
        const primaryEmail = user.primaryEmailAddress?.emailAddress || "";
        return {
          uid: user.id,
          email: primaryEmail,
          displayName: user.fullName || user.firstName || primaryEmail || "Your account",
          photoURL: user.imageUrl || null
        };
      }

      async function saveProfile(profile) {
        const username = profile.username.trim().toLowerCase();
        const nickname = profile.nickname.trim();
        if (!/^[a-z0-9_]{3,24}$/.test(username)) {
          throw new Error("Username must be 3–24 characters and use only letters, numbers, or underscores.");
        }
        if (!nickname || nickname.length > 40) throw new Error("Enter a nickname of up to 40 characters.");
        currentProfile = await authenticatedRequest("/api/profile", {
          method: "PUT",
          body: JSON.stringify({ username, nickname, photoURL: profile.photoURL || null })
        });
        updateAccountUI();
      }

      function showAccountError(element, error) {
        console.error("Account action failed:", error);
        element.textContent = error.message || "Something went wrong. Please try again.";
      }

      async function loadSignedInData(user, sequence) {
        const saved = await authenticatedRequest("/api/bootstrap", { method: "POST" });
        if (sequence !== authStateSequence || currentUser?.uid !== user.uid) return;
        currentUser.dataId = saved.userId || user.uid;
        currentProfile = { ...defaultProfile(user), ...saved.profile, email: user.email };
        if (saved.data) {
          tasks = normalizeTasks(saved.data.tasks);
          settings = normalizeSettings(saved.data.settings);
          cloudUpdatedAt = saved.updatedAt || 0;
        } else {
          if (localStorage.getItem(localStorageKey(STORAGE_KEY)) !== null) {
            tasks = loadTasks(localStorageKey(STORAGE_KEY));
          }
          if (localStorage.getItem(localStorageKey(SETTINGS_KEY)) !== null) {
            settings = loadSettings(localStorageKey(SETTINGS_KEY));
          }
          cloudUpdatedAt = 0;
        }
        saveLocalData();
        cloudReady = true;
        render();
        if (!saved.data) saveCloudData();
        if (cloudPollTimer) window.clearInterval(cloudPollTimer);
        cloudPollTimer = window.setInterval(() => {
          void refreshCloudData();
        }, 15000);
      }

      async function refreshCloudData() {
        if (!cloudReady || !currentUser || cloudWriteInProgress) return;
        const userId = currentUser.uid;
        const revision = localDataRevision;
        try {
          const result = await authenticatedRequest("/api/data");
          if (currentUser?.uid !== userId) return;
          let profileChanged = false;
          if (result.profile) {
            const profile = { ...defaultProfile(currentUser), ...result.profile, email: currentUser.email };
            profileChanged = JSON.stringify(profile) !== JSON.stringify(currentProfile);
            currentProfile = profile;
          }
          if (result.data && result.updatedAt > cloudUpdatedAt
            && revision === localDataRevision && !cloudWriteInProgress) {
            tasks = normalizeTasks(result.data.tasks);
            settings = normalizeSettings(result.data.settings);
            cloudUpdatedAt = result.updatedAt;
            saveLocalData();
            render();
          } else if (profileChanged) {
            render();
          }
        } catch (error) {
          console.error("Could not refresh account data:", error);
        }
      }

      async function syncClerkUser(clerkUser) {
        if (clerkUser && currentUser?.uid === clerkUser.id
          && bootstrappingUserId === clerkUser.id) return;
        const sequence = ++authStateSequence;
        if (!clerkUser) {
          const wasSignedIn = Boolean(currentUser);
          cloudReady = false;
          bootstrappingUserId = null;
          currentUser = null;
          currentProfile = null;
          cloudUpdatedAt = 0;
          if (cloudPollTimer) {
            window.clearInterval(cloudPollTimer);
            cloudPollTimer = null;
          }
          tasks = loadTasks();
          settings = loadSettings();
          render();
          if (wasSignedIn) showToast("You’ve signed out. Your tasks remain saved on this device.");
          return;
        }

        const user = clerkUserProfile(clerkUser);
        if (currentUser?.uid === user.uid && cloudReady) {
          const emailChanged = currentUser.email !== user.email;
          user.dataId = currentUser.dataId || user.uid;
          currentUser = user;
          if (emailChanged) {
            cloudReady = false;
            bootstrappingUserId = user.uid;
            try {
              await loadSignedInData(user, sequence);
            } finally {
              if (bootstrappingUserId === user.uid) bootstrappingUserId = null;
            }
          }
          render();
          return;
        }

        const previousUserId = currentUser?.uid;
        currentUser = user;
        cloudReady = false;
        bootstrappingUserId = user.uid;
        updateAccountUI();
        try {
          await loadSignedInData(user, sequence);
        } finally {
          if (bootstrappingUserId === user.uid) bootstrappingUserId = null;
        }
        if (sequence !== authStateSequence || currentUser?.uid !== user.uid) return;
        if (authDialog.open) authDialog.close();
        if (previousUserId !== user.uid) showToast("Your tasks are syncing with your account.");
      }

      function unmountAuthComponent() {
        const mount = $("#clerk-auth-mount");
        if (!clerk || !mountedAuthMode) return;
        if (mountedAuthMode === "sign-in") clerk.unmountSignIn(mount);
        else clerk.unmountSignUp(mount);
        mountedAuthMode = null;
      }

      function mountAuthComponent() {
        if (!clerk) return;
        unmountAuthComponent();
        const mount = $("#clerk-auth-mount");
        mount.replaceChildren();
        if (creatingAccount) {
          clerk.mountSignUp(mount);
          mountedAuthMode = "sign-up";
          $("#auth-heading").textContent = "Create your account";
          $("#auth-mode-toggle").textContent = "I already have an account";
        } else {
          clerk.mountSignIn(mount);
          mountedAuthMode = "sign-in";
          $("#auth-heading").textContent = "Sign in to Daylight";
          $("#auth-mode-toggle").textContent = "Create an account";
        }
        $("#auth-status").textContent = "";
      }

      async function initializeClerk() {
        try {
          const configResponse = await fetch("/api/config", { cache: "no-store" });
          const config = await configResponse.json().catch(() => ({}));
          if (!configResponse.ok || !config.publishableKey) {
            throw new Error(config.error || "Set the Clerk publishable key in your Netlify environment.");
          }
          const publishableKey = config.publishableKey;
          const encodedDomain = publishableKey.split("_")[2];
          if (!encodedDomain) throw new Error("The Clerk publishable key is invalid.");
          const clerkDomain = atob(encodedDomain).slice(0, -1);
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
            script.async = true;
            script.crossOrigin = "anonymous";
            script.onload = resolve;
            script.onerror = () => reject(new Error("Could not load Clerk’s sign-in interface."));
            document.head.append(script);
          });
          const { Clerk } = await import("@clerk/clerk-js");
          clerk = new Clerk(publishableKey);
          await clerk.load({
            ui: { ClerkUI: window.__internal_ClerkUICtor },
            appearance: {
              variables: {
                colorPrimary: "#a78bfa",
                colorBackground: "#181824",
                colorText: "#f5f4fb",
                colorInputBackground: "#10101a",
                colorInputText: "#f5f4fb"
              }
            }
          });
          clerk.addListener(() => {
            void syncClerkUser(clerk.user).catch((error) => {
              console.error("Could not load Clerk account data:", error);
              showToast(error.message || "Your account data could not be loaded. Check your connection and try again.");
            });
          });
          await syncClerkUser(clerk.user);
          if (authDialog.open && !clerk.user) mountAuthComponent();
        } catch (error) {
          clerkInitError = error;
          console.error("Could not initialize Clerk:", error);
          if (authDialog.open) $("#auth-status").textContent = error.message || "Clerk could not load. Please try again.";
        }
      }

      function openSignIn() {
        $("#auth-status").textContent = clerkInitError?.message || (clerk ? "" : "Connecting to Clerk…");
        authDialog.showModal();
        if (clerk) mountAuthComponent();
      }

      $("#account-button").addEventListener("click", () => {
        if (!currentUser) {
          openSignIn();
          return;
        }
        selectedPhoto = null;
        $("#profile-status").textContent = "";
        $("#profile-username").value = currentProfile?.username || defaultProfile(currentUser).username;
        $("#profile-nickname").value = currentProfile?.nickname || currentUser.displayName || "";
        $("#profile-photo").value = "";
        putAvatar($("#profile-avatar-preview"), currentProfile);
        const clerkPhoto = $("#clerk-profile-photo");
        clerkPhoto.src = currentUser.photoURL || "";
        clerkPhoto.hidden = !currentUser.photoURL;
        $("#clerk-profile-name").textContent = currentUser.displayName;
        $("#clerk-profile-email").textContent = currentUser.email;
        profileDialog.showModal();
      });
      $("#auth-mode-toggle").addEventListener("click", () => {
        creatingAccount = !creatingAccount;
        mountAuthComponent();
      });
      $("#auth-cancel").addEventListener("click", () => authDialog.close());
      $("#profile-cancel").addEventListener("click", () => profileDialog.close());
      $("#manage-clerk-profile").addEventListener("click", async () => {
        if (!clerk) return;
        profileDialog.close();
        try {
          await clerk.openUserProfile();
        } catch (error) {
          showAccountError($("#profile-status"), error);
        }
      });
      $("#profile-photo").addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size >= 2 * 1024 * 1024) {
          $("#profile-status").textContent = "Choose a PNG, JPEG, or WebP image smaller than 2 MB.";
          event.target.value = "";
          return;
        }
        selectedPhoto = file;
        $("#profile-status").textContent = "";
        putAvatar($("#profile-avatar-preview"), { nickname: $("#profile-nickname").value });
        const image = document.createElement("img");
        image.src = URL.createObjectURL(file);
        image.alt = "";
        image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
        image.addEventListener("error", () => URL.revokeObjectURL(image.src), { once: true });
        $("#profile-avatar-preview").replaceChildren(image);
      });
      $("#profile-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!currentUser || !cloudReady) {
          $("#profile-status").textContent = "Your account is still loading. Try again in a moment.";
          return;
        }
        const saveButton = $("#profile-form button[type='submit']");
        saveButton.disabled = true;
        $("#profile-status").textContent = "";
        try {
          let photoURL = currentProfile?.photoURL || currentUser.photoURL || null;
          if (selectedPhoto) {
            const formData = new FormData();
            formData.append("photo", selectedPhoto);
            const uploaded = await authenticatedRequest("/api/profile/photo", {
              method: "POST",
              body: formData
            });
            photoURL = uploaded.photoURL;
          }
          await saveProfile({
            username: $("#profile-username").value,
            nickname: $("#profile-nickname").value,
            photoURL
          });
          profileDialog.close();
          showToast("Your profile was saved.");
        } catch (error) {
          showAccountError($("#profile-status"), error);
        } finally {
          saveButton.disabled = false;
        }
      });
      $("#sign-out").addEventListener("click", async () => {
        if (!clerk) return;
        try {
          await clerk.signOut();
          profileDialog.close();
        } catch (error) {
          showAccountError($("#profile-status"), error);
        }
      });

      function updateClock() {
        const now = new Date();
        $("#live-clock").textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(now);
        $("#today-date").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(now);
      }

      function setPriority(value) {
        selectedPriority = Number(value);
        document.querySelectorAll(".star-choice").forEach((button) => {
          const selected = Number(button.dataset.star) <= selectedPriority;
          button.classList.toggle("selected", selected);
          button.setAttribute("aria-pressed", String(Number(button.dataset.star) === selectedPriority));
        });
      }
      document.querySelectorAll(".star-choice").forEach((button) => {
        button.addEventListener("click", () => setPriority(button.dataset.star));
      });

      $("#add-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const title = taskInput.value.trim();
        if (!title) { taskInput.focus(); return; }
        tasks.push({ id: makeId(), title, priority: selectedPriority, completed: false, createdAt: Date.now(), completedAt: null });
        persistTasks();
        taskInput.value = "";
        setPriority(5);
        render();
        taskInput.focus();
        showToast("Task added. You’re one step closer.");
      });

      function cardAction(event) {
        const button = event.target.closest("[data-action]");
        if (!button) return;
        const card = button.closest(".task-card");
        const task = tasks.find((item) => item.id === card.dataset.id);
        if (!task) return;
        if (button.dataset.action === "toggle") {
          task.completed = !task.completed;
          task.completedAt = task.completed ? Date.now() : null;
          persistTasks();
          render();
          if (task.completed) {
            const completedCard = completedList.querySelector(`[data-id="${CSS.escape(task.id)}"]`);
            if (completedCard) completedCard.classList.add("celebrate");
            showToast("Task complete. Take a moment to enjoy that win.");
          } else showToast("Task restored to your active list.");
        } else if (button.dataset.action === "delete") {
          tasks = tasks.filter((item) => item.id !== task.id);
          persistTasks();
          render();
          showToast("Task deleted.");
        } else if (button.dataset.action === "edit") openEditor(task);
      }
      activeList.addEventListener("click", cardAction);
      completedList.addEventListener("click", cardAction);

      function openEditor(task) {
        editingId = task.id;
        $("#edit-title").value = task.title;
        document.querySelectorAll("[data-edit-star]").forEach((button) => {
          button.classList.toggle("selected", Number(button.dataset.editStar) <= task.priority);
          button.setAttribute("aria-pressed", String(Number(button.dataset.editStar) === task.priority));
        });
        dialog.showModal();
        $("#edit-title").focus();
      }
      document.querySelectorAll("[data-edit-star]").forEach((button) => {
        button.addEventListener("click", () => {
          document.querySelectorAll("[data-edit-star]").forEach((star) => {
            star.classList.toggle("selected", Number(star.dataset.editStar) <= Number(button.dataset.editStar));
            star.setAttribute("aria-pressed", String(star === button));
          });
        });
      });
      $("#edit-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const task = tasks.find((item) => item.id === editingId);
        const title = $("#edit-title").value.trim();
        if (!task || !title) return;
        task.title = title;
        const selected = document.querySelector("[data-edit-star][aria-pressed='true']");
        if (selected) task.priority = Number(selected.dataset.editStar);
        persistTasks();
        dialog.close();
        render();
        showToast("Task updated.");
      });
      $("#cancel-edit").addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

      $("#clear-completed").addEventListener("click", () => {
        if (!tasks.some((task) => task.completed)) return;
        tasks = tasks.filter((task) => !task.completed);
        persistTasks();
        render();
        showToast("Completed tasks cleared.");
      });
      $("#focus-add").addEventListener("click", () => { taskInput.focus(); $("#active-tasks").scrollIntoView({ behavior: "smooth", block: "center" }); });
      $("#pause-reminders").addEventListener("change", (event) => {
        settings.paused = event.target.checked;
        persistSettings();
        render();
        showToast(settings.paused ? "Reminders paused." : "Reminders resumed.");
      });
      function saveHours() {
        const start = $("#wake-start").value;
        const end = $("#wake-end").value;
        if (!start || !end || start >= end) {
          showToast("Choose an end time later than your start time.");
          $("#wake-start").value = settings.start;
          $("#wake-end").value = settings.end;
          return;
        }
        settings.start = start;
        settings.end = end;
        persistSettings();
        showToast("Your reminder hours have been updated.");
      }
      $("#wake-start").addEventListener("change", saveHours);
      $("#wake-end").addEventListener("change", saveHours);

      $("#enable-notifications").addEventListener("click", async () => {
        if (!("Notification" in window)) { updatePermissionUI(); return; }
        if (Notification.permission === "denied") {
          updatePermissionUI();
          showToast("Allow notifications in your browser's site settings, then reload this page.");
          return;
        }
        if (Notification.permission === "granted") {
          showToast("Notifications are enabled. Reminders are scheduled for unfinished tasks.");
          return;
        }
        try {
          const permission = await Notification.requestPermission();
          updatePermissionUI();
          if (permission === "granted") showToast("Notifications enabled. You’ll get gentle reminders during your day.");
          else if (permission === "denied") showToast("Permission was denied. You can allow notifications in browser site settings.");
          else showToast("No permission was granted. You can enable notifications any time.");
        } catch (error) {
          console.error("Could not request notification permission:", error);
          showToast("Your browser couldn't request notification permission. Check browser support and site settings.");
        }
      });

      function dateKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      }
      function scheduledSlots(date, count) {
        const [startHour, startMinute] = settings.start.split(":").map(Number);
        const [endHour, endMinute] = settings.end.split(":").map(Number);
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), startHour, startMinute).getTime();
        const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), endHour, endMinute).getTime();
        const span = end - start;
        return Array.from({ length: count }, (_, index) => start + span * ((index + 1) / (count + 1)));
      }
      function checkReminders() {
        if (!("Notification" in window) || Notification.permission !== "granted" || settings.paused) return;
        const now = new Date();
        const today = dateKey(now);
        const active = tasks.filter((task) => !task.completed);
        let changed = false;
        for (const task of active) {
          const sentKey = `${today}:${task.id}`;
          if (!Array.isArray(settings.sent[sentKey])) { settings.sent[sentKey] = []; changed = true; }
          const slots = scheduledSlots(now, REMINDER_COUNTS[task.priority]);
          slots.forEach((slot, index) => {
            const slotId = `${index}`;
            if (settings.sent[sentKey].includes(slotId)) return;
            // A short delivery window prevents stale reminders from arriving together after a suspended tab resumes.
            if (now.getTime() < slot || now.getTime() - slot > 4 * 60 * 1000) return;
            try {
              const notification = new Notification("A gentle nudge from Daylight", {
                body: `Still on your list: ${task.title}`,
                tag: `daylight-${task.id}-${today}-${index}`,
                icon: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#9278eb"/><circle cx="32" cy="32" r="10" fill="none" stroke="white" stroke-width="4"/><path d="M32 9v7m0 32v7M9 32h7m32 0h7" stroke="white" stroke-width="4" stroke-linecap="round"/></svg>')
              });
              notification.onclick = () => { window.focus(); notification.close(); };
              settings.sent[sentKey].push(slotId);
              changed = true;
            } catch (error) {
              console.error("Could not display a task reminder:", error);
            }
          });
        }
        if (changed) {
          const validKeys = new Set([today, dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))]);
          Object.keys(settings.sent).forEach((key) => {
            if (!validKeys.has(key.split(":")[0])) delete settings.sent[key];
          });
          persistSettings();
        }
      }

      updateClock();
      window.setInterval(updateClock, 1000);
      window.setInterval(checkReminders, 30 * 1000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });
      window.addEventListener("focus", checkReminders);
      window.addEventListener("visibilitychange", () => {
        if (!document.hidden) void refreshCloudData();
      });
      void initializeClerk().catch((error) => {
        clerkInitError = error;
        console.error("Could not initialize Clerk:", error);
        if (authDialog.open) $("#auth-status").textContent = error.message || "Clerk could not load. Please try again.";
      });
      render();
      checkReminders();
    })();
