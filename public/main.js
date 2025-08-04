document.addEventListener('DOMContentLoaded', function () {

    // --- 1. نظام التوست للإشعارات ---
    const toastElement = document.getElementById('responseToast');
    let toast;
    if (toastElement) {
        toast = new bootstrap.Toast(toastElement);
    }
    const toastTitle = document.getElementById('toastTitle');
    const toastBody = document.getElementById('toastBody');

    function showToast(title, message, isSuccess) {
        if (!toast) return;
        toastTitle.textContent = title;
        toastBody.textContent = message;
        toastElement.className = 'toast';
        toastElement.classList.add(isSuccess ? 'text-bg-success' : 'text-bg-danger');
        toast.show();
    }

    // --- 2. تفعيل البحث (فلترة المنتجات) ---

    // --- 3. فورم الشراء المباشر ---
document.querySelectorAll('.buy-form').forEach(form => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new URLSearchParams(new FormData(form));
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Processing...`;

    try {
      const response = await fetch('/buy', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (response.ok && data.success) {
        showToast("Success!", data.message, true);
        setTimeout(() => window.location.href = data.redirectUrl, 2000);
      } else {
        showToast("Error!", data.message || "Purchase failed", false);
      }

    } catch (error) {
      console.error("Fetch Error:", error);
      showToast("Error!", "Connection to server failed.", false);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });
});


    // --- 4. فورم صفحة الدفع ---
    const checkoutForm = document.querySelector('#checkout-form');
    if (checkoutForm) {
        checkoutForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitBtn = checkoutForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Processing...`;

            const formAction = checkoutForm.getAttribute('action');
            const formData = new URLSearchParams(new FormData(checkoutForm));

            try {
                const response = await fetch(formAction, { method: 'POST', body: formData });
                const data = await response.json();

                if (response.ok) {
                    showToast('Success!', data.message, true);
                    setTimeout(() => window.location.href = '/my-orders', 2000);
                } else {
                    showToast('Error!', data.message, false);
                }
            } catch (error) {
                console.error('Fetch Error:', error);
                showToast('Error!', 'Connection to server failed.', false);
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
        });
    }

    // --- 5. فورم تسجيل الدخول ---
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const formData = new URLSearchParams(new FormData(loginForm));
            const errorContainer = document.getElementById('error-message-container');
            errorContainer.innerHTML = '';

            try {
                const response = await fetch('/login', { method: 'POST', body: formData });
                const data = await response.json();
                if (data.success) {
                    window.location.href = data.redirectUrl;
                } else {
                    errorContainer.innerHTML = `<div class="alert alert-danger">${data.message}</div>`;
                }
            } catch (error) {
                errorContainer.innerHTML = `<div class="alert alert-danger">Connection error. Please try again.</div>`;
            }
        });
    }

});
