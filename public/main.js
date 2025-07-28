document.addEventListener('DOMContentLoaded', function () {

    // --- 1. تهيئة نظام الإشعارات (Toast) ---
    const toastElement = document.getElementById('responseToast');
    let toast;
    if (toastElement) {
        toast = new bootstrap.Toast(toastElement);
    }
    const toastTitle = document.getElementById('toastTitle');
    const toastBody = document.getElementById('toastBody');

    // دالة لعرض الإشعارات
    function showToast(title, message, isSuccess) {
        if (!toast) return;
        toastTitle.textContent = title;
        toastBody.textContent = message;
        toastElement.className = 'toast';
        if (isSuccess) {
            toastElement.classList.add('text-bg-success');
        } else {
            toastElement.classList.add('text-bg-danger');
        }
        toast.show();
    }

    // --- 2. تفعيل خاصية البحث (الفلترة) ---
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        const allCards = document.querySelectorAll('.service-card');
        searchInput.addEventListener('input', function () {
            const searchTerm = searchInput.value.toLowerCase();
            allCards.forEach(function (card) {
                const cardTitleElement = card.querySelector('.card-title') || card.querySelector('p');
                if (cardTitleElement) {
                    const cardTitle = cardTitleElement.textContent.toLowerCase();
                    if (cardTitle.includes(searchTerm)) {
                        card.style.display = 'block';
                    } else {
                        card.style.display = 'none';
                    }
                }
            });
        });
    }

    // --- 3. التعامل مع فورم الشراء المباشر (.buy-form) ---
    document.querySelectorAll('.buy-form').forEach(form => {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const formData = new URLSearchParams(new FormData(form));
            try {
                const response = await fetch('/buy', { method: 'POST', body: formData });
                const data = await response.json();
                if (response.ok) {
                    showToast('Success!', data.message, true);
                    setTimeout(() => window.location.href = '/my-orders', 2000);
                } else {
                    showToast('Error!', data.message, false);
                }
            } catch (error) {
                showToast('Error!', 'Connection to server failed.', false);
            }
        });
    });

    // --- 4. التعامل مع فورم صفحة الدفع (#checkout-form) ---
    const checkoutForm = document.querySelector('#checkout-form');
    if (checkoutForm) {
        checkoutForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitBtn = checkoutForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Processing...`;
            
            const formData = new URLSearchParams(new FormData(checkoutForm));
            try {
                const response = await fetch('/process-checkout', { method: 'POST', body: formData });
                const data = await response.json();
                if (response.ok) {
                    showToast('Success!', data.message, true);
                    setTimeout(() => window.location.href = '/my-orders', 2000);
                } else {
                    showToast('Error!', data.message, false);
                }
            } catch (error) {
                showToast('Error!', 'Connection to server failed.', false);
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
        });
    }
});