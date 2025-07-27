document.addEventListener('DOMContentLoaded', function() {

  // اختر شريط البحث
  const searchInput = document.getElementById('searchInput');
  
  // تحقق إذا كان شريط البحث موجودًا في هذه الصفحة
  if (searchInput) {
    const allCards = document.querySelectorAll('.service-card');
    
    searchInput.addEventListener('input', function() {
      const searchTerm = searchInput.value.toLowerCase();

      allCards.forEach(function(card) {
        const cardTitle = card.querySelector('p').textContent.toLowerCase();

        if (cardTitle.includes(searchTerm)) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });
  }
  
  // يمكنك إضافة أي كود آخر هنا ليعمل على كل الصفحات

});


// تشغيل الـ Carousel يدويًا باستخدام الجافا سكريبت
const myCarouselElement = document.querySelector('#carouselExampleIndicators');
const carousel = new bootstrap.Carousel(myCarouselElement, {
  interval: 2500, // المدة 4 ثوانٍ
  ride: 'carousel'
});


document.addEventListener('DOMContentLoaded', function() {
    // ... (أي كود آخر موجود عندك يبقى كما هو، مثل كود الـ Carousel والـ Like) ...

    const buyForms = document.querySelectorAll('.buy-form');
    
    // --- تهيئة الـ Toast ---
    const toastElement = document.getElementById('responseToast');
    const toast = new bootstrap.Toast(toastElement);
    const toastTitle = document.getElementById('toastTitle');
    const toastBody = document.getElementById('toastBody');
    // --- نهاية تهيئة الـ Toast ---

    buyForms.forEach(form => {
        form.addEventListener('submit', function(event) {
            event.preventDefault();
            const formData = new URLSearchParams(new FormData(form));

            fetch('/buy', {
                method: 'POST',
                body: formData
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // --- إشعار النجاح ---
                    toastTitle.textContent = 'Success!';
                    toastBody.textContent = data.message;
                    toastElement.classList.remove('text-bg-danger');
                    toastElement.classList.add('text-bg-success'); // لون أخضر للنجاح
                    toast.show(); // إظهار الإشعار

                    // تحديث الصفحة بعد ثانيتين لإعطاء فرصة لقراءة الإشعار
                    setTimeout(() => {
                        location.reload();
                    }, 2000);

                } else {
                    // --- إشعار الخطأ ---
                    toastTitle.textContent = 'Error!';
                    toastBody.textContent = data.message;
                    toastElement.classList.remove('text-bg-success');
                    toastElement.classList.add('text-bg-danger'); // لون أحمر للخطأ
                    toast.show(); // إظهار الإشعار
                }
            })
            .catch(error => console.error('Error:', error));
        });
    });
});