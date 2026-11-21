(function () {
  const WM = window.WM = window.WM || {};

  // 1. СЛОВАРЬ: Эмодзи -> Код SVG с семантической раскраской
  // В меню/модалках цвета отображаются, а на основных кнопках карты сбрасываются в currentColor через CSS
  const EMOJI_MAP = {
    // 🔍 Поиск
    '🔍': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" stroke="#0ea5e9" stroke-width="2.2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#64748b" stroke-width="2.4"/><path d="M8 8a4 4 0 0 1 4-1" stroke="#38bdf8" stroke-width="1.4"/></svg>`,

    // ✛ Прицел / Крест
    '✛': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke="#64748b" stroke-width="1.8"/><line x1="22" x2="18" y1="12" y2="12" stroke="#f97316" stroke-width="2.2"/><line x1="6" x2="2" y1="12" y2="12" stroke="#f97316" stroke-width="2.2"/><line x1="12" x2="12" y1="6" y2="2" stroke="#f97316" stroke-width="2.2"/><line x1="12" x2="12" y1="22" y2="18" stroke="#f97316" stroke-width="2.2"/><circle cx="12" cy="12" r="2" fill="#f97316"/></svg>`,
    '👆': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#0ea5e9" d="M196 88a27.86 27.86 0 0 0-13.35 3.39A28 28 0 0 0 144 74.7V44a28 28 0 0 0-56 0v80l-3.82-6.13A28 28 0 0 0 35.73 146l4.67 8.23C74.81 214.89 89.05 240 136 240a88.1 88.1 0 0 0 88-88v-36a28 28 0 0 0-28-28m12 64a72.08 72.08 0 0 1-72 72c-37.63 0-47.84-18-81.68-77.68l-4.69-8.27V138A12 12 0 0 1 54 121.61a11.9 11.9 0 0 1 6-1.6a12 12 0 0 1 10.41 6a2 2 0 0 0 .14.23l18.67 30A8 8 0 0 0 104 152V44a12 12 0 0 1 24 0v68a8 8 0 0 0 16 0v-12a12 12 0 0 1 24 0v20a8 8 0 0 0 16 0v-4a12 12 0 0 1 24 0Z"/></svg>`,

    // ⚡ Молния / Медаль
    '⚡': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 4v3" stroke="#3b82f6" stroke-width="2"/><path d="M8 4v6" stroke="#ef4444" stroke-width="2"/><path d="M16 4v6" stroke="#ef4444" stroke-width="2"/><path d="M12 18.5l-3 1.5l.5 -3.5l-2 -2l3 -.5l1.5 -3l1.5 3l3 .5l-2 2l.5 3.5l-3 -1.5" fill="#f59e0b" stroke="#d97706" stroke-width="1.5"/></svg>`,

    // 🔀 Перемешивание / Смена карт
    '🔀': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M15 16.572v2.42a2.01 2.01 0 0 1 -2.009 2.008h-7.981a2.01 2.01 0 0 1 -2.01 -2.009v-7.981a2.01 2.01 0 0 1 2.009 -2.01h2.954" stroke="#64748b" stroke-width="1.8"/><path d="M9.167 4.511a2.04 2.04 0 0 1 2.496 -1.441l7.826 2.097a2.04 2.04 0 0 1 1.441 2.496l-2.097 7.826a2.04 2.04 0 0 1 -2.496 1.441l-7.827 -2.097a2.04 2.04 0 0 1 -1.441 -2.496l2.098 -7.827l0 .001" stroke="#0ea5e9" stroke-width="2"/></svg>`,

    // 👁️ Глаз / Показать
    '👁️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" stroke="#64748b" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="#0284c7" stroke-width="2" fill="#38bdf8"/></svg>`,
    '👁': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" stroke="#64748b" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="#0284c7" stroke-width="2" fill="#38bdf8"/></svg>`,

    // 🕶️ Скрыть / Глаз перечеркнутый
    '🕶️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" stroke="#94a3b8" stroke-width="2"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" stroke="#94a3b8" stroke-width="2"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" stroke="#94a3b8" stroke-width="2"/><path d="m2 2 20 20" stroke="#ef4444" stroke-width="2.2"/></svg>`,
    '🕶': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" stroke="#94a3b8" stroke-width="2"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" stroke="#94a3b8" stroke-width="2"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" stroke="#94a3b8" stroke-width="2"/><path d="m2 2 20 20" stroke="#ef4444" stroke-width="2.2"/></svg>`,

    // 🌙 Луна / Ночная тема
    '🌙': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" d="M9.822 2.238a9 9 0 0 0 11.94 11.94C20.768 18.654 16.775 22 12 22C6.477 22 2 17.523 2 12c0-4.775 3.346-8.768 7.822-9.762"/><path fill="#38bdf8" d="M18.164 2.291L19 2.5v1l-.836.209a2 2 0 0 0-1.455 1.455L16.5 6h-1l-.209-.836a2 2 0 0 0-1.455-1.455L13 3.5v-1l.836-.209A2 2 0 0 0 15.29.836L15.5 0h1l.209.836a2 2 0 0 0 1.455 1.455m5 5L24 7.5v1l-.836.209a2 2 0 0 0-1.455 1.455L21.5 11h-1l-.209-.836a2 2 0 0 0-1.455-1.455L18 8.5v-1l.836-.209a2 2 0 0 0 1.455-1.455L20.5 5h1l.209.836a2 2 0 0 0 1.455 1.455"/></svg>`,

    // ☀️ Солнце / Дневная тема
    '☀️': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.8" fill="#f59e0b"/><path fill="#fbbf24" d="M12 19a1 1 0 0 1 .993.883L13 20v1a1 1 0 0 1-1.993.117L11 21v-1a1 1 0 0 1 1-1m6.313-2.09l.094.083l.7.7a1 1 0 0 1-1.32 1.497l-.094-.083l-.7-.7a1 1 0 0 1 1.218-1.567zm-11.306.083a1 1 0 0 1 .083 1.32l-.083.094l-.7.7a1 1 0 0 1-1.497-1.32l.083-.094l.7-.7a1 1 0 0 1 1.414 0M4 11a1 1 0 0 1 .117 1.993L4 13H3a1 1 0 0 1-.117-1.993L3 11zm17 0a1 1 0 0 1 .117 1.993L21 13h-1a1 1 0 0 1-.117-1.993L20 11zM6.213 4.81l.094.083l.7.7a1 1 0 0 1-1.32 1.497l-.094-.083l-.7-.7A1 1 0 0 1 6.11 4.74zm12.894.083a1 1 0 0 1 .083 1.32l-.083.094l-.7.7a1 1 0 0 1-1.497-1.32l.083-.094l.7-.7a1 1 0 0 1 1.414 0M12 2a1 1 0 0 1 .993.883L13 3v1a1 1 0 0 1-1.993.117L11 4V3a1 1 0 0 1 1-1"/></svg>`,
    '☀': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.8" fill="#f59e0b"/><path fill="#fbbf24" d="M12 19a1 1 0 0 1 .993.883L13 20v1a1 1 0 0 1-1.993.117L11 21v-1a1 1 0 0 1 1-1m6.313-2.09l.094.083l.7.7a1 1 0 0 1-1.32 1.497l-.094-.083l-.7-.7a1 1 0 0 1 1.218-1.567zm-11.306.083a1 1 0 0 1 .083 1.32l-.083.094l-.7.7a1 1 0 0 1-1.497-1.32l.083-.094l.7-.7a1 1 0 0 1 1.414 0M4 11a1 1 0 0 1 .117 1.993L4 13H3a1 1 0 0 1-.117-1.993L3 11zm17 0a1 1 0 0 1 .117 1.993L21 13h-1a1 1 0 0 1-.117-1.993L20 11zM6.213 4.81l.094.083l.7.7a1 1 0 0 1-1.32 1.497l-.094-.083l-.7-.7A1 1 0 0 1 6.11 4.74zm12.894.083a1 1 0 0 1 .083 1.32l-.083.094l-.7.7a1 1 0 0 1-1.497-1.32l.083-.094l.7-.7a1 1 0 0 1 1.414 0M12 2a1 1 0 0 1 .993.883L13 3v1a1 1 0 0 1-1.993.117L11 4V3a1 1 0 0 1 1-1"/></svg>`,

    // 🔴 Ночной режим / Контраст
    '🔴': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><circle cx="12" cy="12" r="9" stroke="#ef4444" stroke-width="2"/><line x1="12" y1="3" x2="12" y2="21" stroke="#ef4444" stroke-width="2"/><path d="M12 9l4.65 -4.65M12 14.3l7.37 -7.37M12 19.6l8.85 -8.85" stroke="#f87171" stroke-width="1.8"/></svg>`,

    // ⚙️ Настройки
    '⚙️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" stroke="#64748b" stroke-width="2"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" stroke="#0ea5e9" stroke-width="2.2"/></svg>`,
    '⚙': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" stroke="#64748b" stroke-width="2"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" stroke="#0ea5e9" stroke-width="2.2"/></svg>`,
    // 🔄 Обновить
    '🔄': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.06189 13C4.02104 12.6724 4 12.3387 4 12C4 7.58172 7.58172 4 12 4C14.5006 4 16.7332 5.14727 18.2002 6.94416" stroke="#0ea5e9" stroke-width="2.2"/><path d="M19.9381 11C19.979 11.3276 20 11.6613 20 12C20 16.4183 16.4183 20 12 20C9.61061 20 7.46589 18.9525 6 17.2916" stroke="#10b981" stroke-width="2.2"/><path d="M9 17H6V17.2916M6 20V17.2916" stroke="#10b981" stroke-width="2.2"/><path d="M18.2002 4V6.94416M18.2002 6.94416V6.99993L15.2002 7" stroke="#0ea5e9" stroke-width="2.2"/></svg>`,

    // ✕ Закрыть
    '✕': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    '✖': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,

    // Стрелки влево / вправо / вверх / вниз
    '◀': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#64748b" d="m3.86 8.753l5.482 4.796c.646.566 1.658.106 1.658-.753V3.204a1 1 0 0 0-1.659-.753l-5.48 4.796a1 1 0 0 0 0 1.506z"/></svg>`,
    '▶': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#10b981" d="m12.14 8.753l-5.482 4.796c-.646.566-1.658.106-1.658-.753V3.204a1 1 0 0 1 1.659-.753l5.48 4.796a1 1 0 0 1 0 1.506z"/></svg>`,
    '▲': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#0ea5e9" d="M414 321.94L274.22 158.82a24 24 0 0 0-36.44 0L98 321.94c-13.34 15.57-2.28 39.62 18.22 39.62h279.6c20.5 0 31.56-24.05 18.18-39.62"/></svg>`,
    '▼': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#64748b" d="m98 190.06l139.78 163.12a24 24 0 0 0 36.44 0L414 190.06c13.34-15.57 2.28-39.62-18.22-39.62h-279.6c-20.5 0-31.56 24.05-18.18 39.62"/></svg>`,

    // Развернуть / Свернуть
    '⤢': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/></svg>`,
    '⤡': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/></svg>`,

    // 🛰️ Спутник
    '🛰️': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-width="1.8"><path d="M12.536 6.11a3.787 3.787 0 0 1 5.355 5.354l-2.142 2.143c-.86.86-1.291 1.29-1.812 1.373a1.6 1.6 0 0 1-.508 0c-.52-.082-.95-.513-1.812-1.373l-1.224-1.224c-.86-.861-1.29-1.291-1.373-1.812a1.6 1.6 0 0 1 0-.508c.082-.52.513-.951 1.373-1.812z" stroke="#f59e0b" fill="rgba(245, 158, 11, 0.15)"/><path stroke="#06b6d4" stroke-linecap="round" stroke-linejoin="round" d="M6.848 14c.12 1.57 1.57 3.008 3.152 3.13m-6.994-1.892c-.154 3.028 2.748 5.904 5.798 5.757"/><path stroke="#3b82f6" d="m12.53 5.53l-1.596-1.663C10.356 3.29 10.066 3 9.707 3s-.648.29-1.226.867l-.614.614C7.29 5.059 7 5.348 7 5.707c0 .36.29.648.867 1.227l1.451 1.45m9.103 2.971l1.712 1.711c.578.579.867.868.867 1.227s-.29.648-.867 1.226l-.614.614c-.578.578-.867.867-1.226.867c-.36 0-.648-.29-1.227-.867l-1.555-1.555"/></g></svg>`,
    '🛰': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-width="1.8"><path d="M12.536 6.11a3.787 3.787 0 0 1 5.355 5.354l-2.142 2.143c-.86.86-1.291 1.29-1.812 1.373a1.6 1.6 0 0 1-.508 0c-.52-.082-.95-.513-1.812-1.373l-1.224-1.224c-.86-.861-1.29-1.291-1.373-1.812a1.6 1.6 0 0 1 0-.508c.082-.52.513-.951 1.373-1.812z" stroke="#f59e0b" fill="rgba(245, 158, 11, 0.15)"/><path stroke="#06b6d4" stroke-linecap="round" stroke-linejoin="round" d="M6.848 14c.12 1.57 1.57 3.008 3.152 3.13m-6.994-1.892c-.154 3.028 2.748 5.904 5.798 5.757"/><path stroke="#3b82f6" d="m12.53 5.53l-1.596-1.663C10.356 3.29 10.066 3 9.707 3s-.648.29-1.226.867l-.614.614C7.29 5.059 7 5.348 7 5.707c0 .36.29.648.867 1.227l1.451 1.45m9.103 2.971l1.712 1.711c.578.579.867.868.867 1.227s-.29.648-.867 1.226l-.614.614c-.578.578-.867.867-1.226.867c-.36 0-.648-.29-1.227-.867l-1.555-1.555"/></g></svg>`,

    // 👣 Следы шагов
    '👣': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><g stroke="#d97706" stroke-width="2"><path d="M4 16.5a2.5 2.5 0 0 0 5 0a1.5 1.5 0 0 0 -1.5 -1.5h-2a1.5 1.5 0 0 0 -1.5 1.5"/><path d="M15 18.5a2.5 2.5 0 0 0 5 0a1.5 1.5 0 0 0 -1.5 -1.5h-2a1.5 1.5 0 0 0 -1.5 1.5"/><path d="M8.52 12h-4.04c-.348 0 -.678 -.179 -.823 -.496c-1.326 -2.904 -.774 -8.504 2.843 -8.504s4.17 5.6 2.843 8.504c-.145 .317 -.475 .496 -.824 .496"/><path d="M19.52 14h-4.04c-.348 0 -.678 -.179 -.823 -.496c-1.326 -2.904 -.774 -8.504 2.843 -8.504s4.17 5.6 2.843 8.504c-.145 .317 -.475 .496 -.824 .496"/></g></svg>`,

    // 🧲 Магнит
    '🧲': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15V7a8 8 0 0 1 16 0v8" stroke="#64748b"/><path d="M4 15v3a2 2 0 0 0 4 0v-3" fill="#ef4444" stroke="#dc2626"/><path d="M16 15v3a2 2 0 0 0 4 0v-3" fill="#3b82f6" stroke="#2563eb"/><line x1="4" y1="12" x2="8" y2="12" stroke="#ef4444"/><line x1="16" y1="12" x2="20" y2="12" stroke="#3b82f6"/></svg>`,

    // ⚠️ Внимание / Предупреждение
    '⚠️': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" d="M12 1.67c.955 0 1.845.467 2.39 1.247l.105.16l8.114 13.548a2.914 2.914 0 0 1-2.307 4.363l-.195.008H3.882a2.914 2.914 0 0 1-2.582-4.2l.099-.185l8.11-13.538A2.91 2.91 0 0 1 12 1.67"/><path fill="#0f172a" d="M12.01 15l-.127.007a1 1 0 0 0 0 1.986L12 17l.127-.007a1 1 0 0 0 0-1.986zM12 8a1 1 0 0 0-.993.883L11 9v4l.007.117a1 1 0 0 0 1.986 0L13 13V9l-.007-.117A1 1 0 0 0 12 8"/></svg>`,
    '⚠': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" d="M12 1.67c.955 0 1.845.467 2.39 1.247l.105.16l8.114 13.548a2.914 2.914 0 0 1-2.307 4.363l-.195.008H3.882a2.914 2.914 0 0 1-2.582-4.2l.099-.185l8.11-13.538A2.91 2.91 0 0 1 12 1.67"/><path fill="#0f172a" d="M12.01 15l-.127.007a1 1 0 0 0 0 1.986L12 17l.127-.007a1 1 0 0 0 0-1.986zM12 8a1 1 0 0 0-.993.883L11 9v4l.007.117a1 1 0 0 0 1.986 0L13 13V9l-.007-.117A1 1 0 0 0 12 8"/></svg>`,

    // 🧭 Компас
    '🧭': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#475569" stroke-width="2"/><mask id="wm-compass-hole"><rect width="24" height="24" fill="#ffffff"/><circle cx="12" cy="12" r="2.2" fill="#000000"/></mask><g mask="url(#wm-compass-hole)"><path d="M16.24 7.76 L13.41 13.41 L12 12 Z" fill="#ef4444"/><path d="M16.24 7.76 L12 12 L10.59 10.59 Z" fill="#dc2626"/><path d="M7.76 16.24 L10.59 10.59 L12 12 Z" fill="#94a3b8"/><path d="M7.76 16.24 L12 12 L13.41 13.41 Z" fill="#64748b"/></g><circle cx="12" cy="12" r="2.2" fill="none" stroke="#475569" stroke-width="1.3"/></svg>`,

    // 🐾 Лапы / След
    '🐾': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#b45309" d="M228 200a28 28 0 0 1-54.83 8H72a48 48 0 0 1 0-96h96a24 24 0 0 0 0-48H72a8 8 0 0 1 0-16h96a40 40 0 0 1 0 80H72a32 32 0 0 0 0 64h101.17a28 28 0 0 1 54.83 8"/></svg>`,

    // ↗️ Стрелка вправо-вверх
    '↗️': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#0284c7" d="M7.75 2a.75.75 0 0 0 0 1.5h3.69l-1.22 1.22a.75.75 0 1 0 1.06 1.06l1.22-1.22v3.69a.75.75 0 0 0 1.5 0v-5.5a.75.75 0 0 0-.75-.75zm1.03 6.28a.75.75 0 0 0-1.06-1.06l-1.5 1.5a.75.75 0 0 0 1.06 1.06zm-4 4a.75.75 0 1 0-1.06-1.06l-1.5 1.5a.75.75 0 1 0 1.06 1.06z"/></svg>`,
    '↗': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#0284c7" d="M7.75 2a.75.75 0 0 0 0 1.5h3.69l-1.22 1.22a.75.75 0 1 0 1.06 1.06l1.22-1.22v3.69a.75.75 0 0 0 1.5 0v-5.5a.75.75 0 0 0-.75-.75zm1.03 6.28a.75.75 0 0 0-1.06-1.06l-1.5 1.5a.75.75 0 0 0 1.06 1.06zm-4 4a.75.75 0 1 0-1.06-1.06l-1.5 1.5a.75.75 0 1 0 1.06 1.06z"/></svg>`,

    // Способы передвижения
    '🚶': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#10b981" d="M120 48a32 32 0 1 1 32 32a32 32 0 0 1-32-32m72 88c-23.37 0-28.92-8.56-36.6-20.4c-3.65-5.64-7.79-12-14.16-17.55a41 41 0 0 0-8-5.47a8 8 0 0 0-11 3.92L64.66 228.81a8 8 0 0 0 4.15 10.52A7.8 7.8 0 0 0 72 240a8 8 0 0 0 7.34-4.81l33.59-77.27l31.07 22.2V232a8 8 0 0 0 16 0v-56a8 8 0 0 0-3.35-6.51l-37.2-26.57l13.4-30.81c3.57 3.62 6.28 7.8 9.13 12.19c7.67 11.84 16.27 25.11 42 27.36V232a8 8 0 0 0 16 0v-88a8 8 0 0 0-7.98-8M72 152a8 8 0 0 0 7.36-4.85l24-56a8 8 0 0 0-4.2-10.5l-28-12a8 8 0 0 0-10.5 4.2l-24 56a8 8 0 0 0 4.2 10.5l28 12A8 8 0 0 0 72 152"/></svg>`,
    '🏃': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f97316" d="M16.5 5.5a2 2 0 0 0 2-2a2 2 0 0 0-2-2a2 2 0 0 0-2 2a2 2 0 0 0 2 2m-3.6 13.9l1-4.4l2.1 2v6h2v-7.5l-2.1-2l.6-3A7.3 7.3 0 0 0 22 13v-2c-1.76.03-3.4-.89-4.3-2.4l-1-1.6c-.36-.6-1-1-1.7-1c-.3 0-.5.1-.8.1L9 8.3V13h2V9.6l1.8-.7l-1.6 8.1l-4.9-1l-.4 2zM4 9a1 1 0 0 1-1-1a1 1 0 0 1 1-1h3v2zm1-4a1 1 0 0 1-1-1a1 1 0 0 1 1-1h5v2zm-2 8a1 1 0 0 1-1-1a1 1 0 0 1 1-1h4v2z"/></svg>`,
    '🚲': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#64748b" d="M388 448a92 92 0 1 1 92-92a92.1 92.1 0 0 1-92 92m0-152a60 60 0 1 0 60 60a60.07 60.07 0 0 0-60-60M124 448a92 92 0 1 1 92-92a92.1 92.1 0 0 1-92 92m0-152a60 60 0 1 0 60 60a60.07 60.07 0 0 0-60-60"/><circle cx="320" cy="96" r="32" fill="#06b6d4"/><path fill="#06b6d4" d="M367.55 192h-43.76a4 4 0 0 1-3.51-2.08l-31.74-58.17a31 31 0 0 0-49.38-7.75l-69.86 70.4a32.56 32.56 0 0 0-9.3 22.4c0 17.4 12.6 23.6 18.5 27.1c28.5 16.42 48.57 28.43 59.58 35.1a4 4 0 0 1 1.92 3.41v69.12c0 8.61 6.62 16 15.23 16.43A16 16 0 0 0 272 352v-86a16 16 0 0 0-6.66-13l-37-26.61a4 4 0 0 1-.58-6l42-44.79a4 4 0 0 1 6.42.79L298 215.77a16 16 0 0 0 14 8.23h56a16 16 0 0 0 16-16.77c-.42-8.61-7.84-15.23-16.45-15.23"/></svg>`,
    '🚗': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none"><path stroke="#2563eb" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m3 11l2.48-5.788A2 2 0 0 1 7.32 4h9.362a2 2 0 0 1 1.838 1.212L21 11M3 11h18M3 11v7m18-7v7m-3 0v.5a1.5 1.5 0 0 0 1.5 1.5v0a1.5 1.5 0 0 0 1.5-1.5V18m-3 0H6m12 0h3M6 18v.5A1.5 1.5 0 0 1 4.5 20v0A1.5 1.5 0 0 1 3 18.5V18m3 0H3"/><path fill="#38bdf8" fill-opacity="0.25" d="M7.32 5l-2.14 5h13.64l-2.14-5z"/><circle cx="6.5" cy="14.5" r="1.5" fill="#facc15"/><circle cx="17.5" cy="14.5" r="1.5" fill="#facc15"/></g></svg>`,

    // Звуки и оповещения
    '📳': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#6366f1" d="M160 32H96a24 24 0 0 0-24 24v144a24 24 0 0 0 24 24h64a24 24 0 0 0 24-24V56a24 24 0 0 0-24-24m-8 176H104a8 8 0 0 1 0-16h48a8 8 0 0 1 0 16"/><path fill="#a855f7" d="M208 88a8 8 0 0 1 8 8v64a8 8 0 0 1-16 0V96a8 8 0 0 1 8-8m32 16a8 8 0 0 1 8 8v32a8 8 0 0 1-16 0v-32a8 8 0 0 1 8-8M48 88a8 8 0 0 1 8 8v64a8 8 0 0 1-16 0V96a8 8 0 0 1 8-8M16 104a8 8 0 0 1 8 8v32a8 8 0 0 1-16 0v-32a8 8 0 0 1 8-8"/></svg>`,
    '🔕': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" d="M19 15.8V11c0-3.1-2.03-5.83-5-6.71V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v.29c-.61.18-1.2.45-1.74.8M12 23a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2"/><path fill="#ef4444" d="M20.84 22.73L18.11 20H3v-1l2-2v-6c0-1.14.29-2.27.83-3.28L1.11 3l1.28-1.27l19.72 19.73z"/></svg>`,
    '🔊': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" stroke="#64748b" stroke-width="2" fill="rgba(100, 116, 139, 0.15)"/><path d="M16 9a5 5 0 0 1 0 6" stroke="#10b981" stroke-width="2"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728" stroke="#10b981" stroke-width="2"/></svg>`,
    '🔇': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" stroke="#94a3b8" stroke-width="1.8"/><path d="m2 2 20 20" stroke="#ef4444" stroke-width="2.2"/></svg>`,

    // 🔋 Батарея
    '🔋': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none"><rect x="3" y="6" width="16" height="12" rx="2.5" stroke="#64748b" stroke-width="2"/><path d="M21 10v4" stroke="#64748b" stroke-width="2" stroke-linecap="round"/><path d="M11 8.5L9 12h4l-2 3.5" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g></svg>`,

    // Лаборатория / Эксперименты
    '🔬': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18h8M3 22h18M14 22a7 7 0 1 0 0-14h-1" stroke="#475569" stroke-width="2"/><path d="M9 14h2" stroke="#0ea5e9" stroke-width="2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z" stroke="#f59e0b" stroke-width="2" fill="rgba(245, 158, 11, 0.15)"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3" stroke="#64748b" stroke-width="2"/></svg>`,
    '🧪': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7 6.82 21.18a2.83 2.83 0 0 1-3.99-.01a2.83 2.83 0 0 1 0-4L17 3" stroke="#38bdf8" stroke-width="2"/><path d="m16 2 6 6" stroke="#0284c7" stroke-width="2"/><path d="M12 16H4" stroke="#10b981" stroke-width="2.5"/></svg>`,

    // Управление записью / Плеер
    '⏺️': `<svg class="emoji-svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="220" fill="none" stroke="#f87171" stroke-width="28"/><circle cx="256" cy="256" r="140" fill="#ef4444"/></svg>`,
    '⏺': `<svg class="emoji-svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="220" fill="none" stroke="#f87171" stroke-width="28"/><circle cx="256" cy="256" r="140" fill="#ef4444"/></svg>`,
    '▶️': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#10b981" d="M133 440a35.37 35.37 0 0 1-17.5-4.67c-12-6.8-19.46-20-19.46-34.33V111c0-14.37 7.46-27.53 19.46-34.33a35.13 35.13 0 0 1 35.77.45l247.85 148.36a36 36 0 0 1 0 61l-247.89 148.4A35.5 35.5 0 0 1 133 440"/></svg>`,
    '⏸️': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#f59e0b" d="M208 432h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16m144 0h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16"/></svg>`,
    '⏸': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#f59e0b" d="M208 432h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16m144 0h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16"/></svg>`,

    // Файлы, папки и сохранение
    '💾': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#3b82f6" d="m465.94 119.76l-73.7-73.7A47.68 47.68 0 0 0 358.3 32H96a64 64 0 0 0-64 64v320a64 64 0 0 0 64 64h320a64 64 0 0 0 64-64V153.7a47.68 47.68 0 0 0-14.06-33.94M120 112h176a8 8 0 0 1 8 8v48a8 8 0 0 1-8 8H120a8 8 0 0 1-8-8v-48a8 8 0 0 1 8-8m139.75 319.91a80 80 0 1 1 76.16-76.16a80.06 80.06 0 0 1-76.16 76.16"/><rect x="120" y="80" width="180" height="70" rx="6" fill="#e2e8f0"/><circle cx="256" cy="352" r="48" fill="#1e293b"/></svg>`,
    '📁': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h6l2 2h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20z"/></svg>`,
    '📂': `<svg class="emoji-svg" viewBox="0 0 20 20"><path fill="#d97706" d="M18.405 4.799c-.111-.44-.655-.799-1.21-.799h-6.814c-.554 0-1.33-.318-1.722-.707l-.596-.588C7.671 2.316 6.896 2 6.342 2H3.087c-.555 0-1.059.447-1.12.994L1.675 6h16.931l-.201-1.201z"/><path fill="#f59e0b" d="M19.412 7H.588a.58.58 0 0 0-.577.635l.923 9.669A.77.77 0 0 0 1.7 18h16.6a.77.77 0 0 0 .766-.696l.923-9.669A.58.58 0 0 0 19.412 7z"/></svg>`,
    '🌐': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke="#0284c7"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" stroke="#38bdf8"/><path d="M2 12h20" stroke="#0ea5e9"/></svg>`,
    '📈': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" stroke="#64748b" stroke-width="2"/><path d="M14 2v5a1 1 0 0 0 1 1h5" stroke="#64748b" stroke-width="2"/><path d="m16 13-3.5 3.5-2-2L8 17" stroke="#10b981" stroke-width="2.2"/></svg>`,
    '📐': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="none" stroke="#f59e0b" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 4h14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-7a1 1 0 0 0-1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1"/><path stroke="#d97706" stroke-width="1.8" d="M4 8h2m-2 4h3m-3 4h2M8 4v2m4-2v3m4-3v2"/></svg>`,
    '📏': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="none" stroke="#d97706" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Zm-6.8-2.8l2-2m-5-1l2-2m-5-1l2-2m7 11l2-2"/></svg>`,
    '🏢': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none"><path d="M7.5 3L3 21h9l4.5-18z" fill="rgba(100, 116, 139, 0.2)"/><path stroke="#64748b" stroke-linecap="square" stroke-width="2" d="M21 21h-9m0 0H3L7.5 3h9z"/><path stroke="#facc15" stroke-width="2" d="M7 7.5h3.875M5.5 12h4.25M4.5 16.5h4.125"/></g></svg>`,
    '🎯': `<svg class="emoji-svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="94" fill="none" stroke="#ef4444" stroke-width="16"/><circle cx="128" cy="128" r="54" fill="none" stroke="#64748b" stroke-width="12"/><circle cx="128" cy="128" r="22" fill="#ef4444"/><path stroke="#ef4444" stroke-width="12" d="M128 20v24M128 212v24M20 128h24M212 128h24"/></svg>`,
    '✨': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="currentColor" d="m232.49 200.49l-32 32a12 12 0 0 1-17-17L195 204H80a12 12 0 0 1-12-12V69L56.49 80.49a12 12 0 1 1-17-17l32-32a12 12 0 0 1 17 0l32 32a12 12 0 0 1-17 17L92 69v111h103l-11.52-11.51a12 12 0 0 1 17-17l32 32a12 12 0 0 1 .01 17"/><g fill="#f97316" stroke="#f97316" stroke-width="6" stroke-linecap="round"><circle cx="133.5" cy="78" r="24" stroke="none" rx="41.5" ry="40" transform="translate(23,-27)"/><line x1="136" y1="42" x2="136" y2="30" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="136" y1="106" x2="136" y2="118" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="104" y1="74" x2="92" y2="74" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="168" y1="74" x2="180" y2="74" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="113" y1="51" x2="105" y2="43" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="159" y1="97" x2="167" y2="105" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="113" y1="97" x2="105" y2="105" transform="translate(28.227,-16.273) scale(0.943,0.909)"/><line x1="159" y1="51" x2="167" y2="43" transform="translate(28.227,-16.273) scale(0.943,0.909)"/></g><path fill="#38bdf8" d="M210 90 A44 44 0 0 0 210 178 A56 56 0 0 1 210 90 Z" transform="translate(31,-12.667) rotate(238.807,188,134)"/></svg>`,
    '↩':  `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#64748b" d="M7 19v-2h7.1q1.575 0 2.738-1T18 13.5T16.838 11T14.1 10H7.8l2.6 2.6L9 14L4 9l5-5l1.4 1.4L7.8 8h6.3q2.425 0 4.163 1.575T20 13.5t-1.737 3.925T14.1 19z"/></svg>`,
    '📍': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#ef4444" fill-rule="evenodd" clip-rule="evenodd" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7m0 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z"/></svg>`,
    '📋': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" stroke="#b45309" fill="rgba(180, 83, 9, 0.1)"/><path d="M8 11h8M8 7h6" stroke="#0284c7"/></svg>`,
    '🏷️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" stroke="#f97316" stroke-width="2" fill="rgba(249, 115, 22, 0.15)"/><circle cx="7.5" cy="7.5" r="1.5" fill="#f97316"/></svg>`,
    '🏷': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" stroke="#f97316" stroke-width="2" fill="rgba(249, 115, 22, 0.15)"/><circle cx="7.5" cy="7.5" r="1.5" fill="#f97316"/></svg>`,
    '🎨': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none"><path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" stroke="#d97706" stroke-width="2" fill="rgba(217, 119, 6, 0.15)"/><circle cx="13.5" cy="6.5" r="1.3" fill="#ef4444"/><circle cx="17.5" cy="10.5" r="1.3" fill="#3b82f6"/><circle cx="6.5" cy="12.5" r="1.3" fill="#10b981"/><circle cx="8.5" cy="7.5" r="1.3" fill="#facc15"/></svg>`,
    '🖌️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m14.622 17.897-10.68-2.913" stroke="#94a3b8" stroke-width="2"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z" stroke="#b45309" stroke-width="2" fill="rgba(180, 83, 9, 0.2)"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15" stroke="#3b82f6" stroke-width="2"/></svg>`,
    '🖌': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m14.622 17.897-10.68-2.913" stroke="#94a3b8" stroke-width="2"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z" stroke="#b45309" stroke-width="2" fill="rgba(180, 83, 9, 0.2)"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15" stroke="#3b82f6" stroke-width="2"/></svg>`,
    '🗺️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" stroke="#10b981" fill="rgba(16, 185, 129, 0.12)"/><path d="M15 5.764v15M9 3.236v15" stroke="#0ea5e9"/></svg>`,
    '🗺': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" stroke="#10b981" fill="rgba(16, 185, 129, 0.12)"/><path d="M15 5.764v15M9 3.236v15" stroke="#0ea5e9"/></svg>`,
    '📜': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>`,
    '🗑️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    '🗑': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    '✏️': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" stroke="#f59e0b" stroke-width="2" fill="rgba(245, 158, 11, 0.15)"/><path d="m15 5 4 4" stroke="#f43f5e" stroke-width="2"/></svg>`,
    '✏': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" stroke="#f59e0b" stroke-width="2" fill="rgba(245, 158, 11, 0.15)"/><path d="m15 5 4 4" stroke="#f43f5e" stroke-width="2"/></svg>`,

    // Природа, ландшафт и фауна
    '🏔️': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-linejoin="round" stroke-width="1.8"><path stroke="#38bdf8" stroke-linecap="round" d="m6.297 10.052l1.493 1.492m2.718 1.492l1.295 1.618c.16.2.241.301.328.362c.233.164.54.181.79.044c.093-.051.184-.142.366-.324c.165-.165.247-.248.333-.297a.75.75 0 0 1 .745 0c.085.05.168.132.333.297c.182.182.273.273.366.324c.25.137.557.12.79-.044c.087-.061.167-.162.328-.362l1.295-1.618"/><path stroke="#64748b" d="M15.992 20h-14l3.225-9.244C6.787 6.252 7.573 4 8.992 4c1.337 0 2.112 2 3.512 6"/><path stroke="#64748b" stroke-linecap="round" d="M5.992 20h16L17.4 12.659C15.873 10.219 15.109 9 13.992 9s-1.88 1.22-3.406 3.659L9.12 15"/></g></svg>`,
    '🏔': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-linejoin="round" stroke-width="1.8"><path stroke="#38bdf8" stroke-linecap="round" d="m6.297 10.052l1.493 1.492m2.718 1.492l1.295 1.618c.16.2.241.301.328.362c.233.164.54.181.79.044c.093-.051.184-.142.366-.324c.165-.165.247-.248.333-.297a.75.75 0 0 1 .745 0c.085.05.168.132.333.297c.182.182.273.273.366.324c.25.137.557.12.79-.044c.087-.061.167-.162.328-.362l1.295-1.618"/><path stroke="#64748b" d="M15.992 20h-14l3.225-9.244C6.787 6.252 7.573 4 8.992 4c1.337 0 2.112 2 3.512 6"/><path stroke="#64748b" stroke-linecap="round" d="M5.992 20h16L17.4 12.659C15.873 10.219 15.109 9 13.992 9s-1.88 1.22-3.406 3.659L9.12 15"/></g></svg>`,
    '⛰️': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#15803d" d="M13.2 7.07L10.25 11l2.25 3c.33.44.24 1.07-.2 1.4a.994.994 0 0 1-1.4-.2c-1.05-1.4-2.31-3.07-3.1-4.14c-.4-.53-1.2-.53-1.6 0l-4 5.33c-.49.67-.02 1.61.8 1.61h18c.82 0 1.29-.94.8-1.6l-7-9.33a.993.993 0 0 0-1.6 0"/></svg>`,
    '⛰': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#15803d" d="M13.2 7.07L10.25 11l2.25 3c.33.44.24 1.07-.2 1.4a.994.994 0 0 1-1.4-.2c-1.05-1.4-2.31-3.07-3.1-4.14c-.4-.53-1.2-.53-1.6 0l-4 5.33c-.49.67-.02 1.61.8 1.61h18c.82 0 1.29-.94.8-1.6l-7-9.33a.993.993 0 0 0-1.6 0"/></svg>`,
    '〰️': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#0284c7" d="M7 18.95q-1.225 0-1.95.55t-2.025.775q-.425.075-.725-.2t-.3-.7t.287-.712T3 18.25q.9-.275 1.7-.763T7 17q.95 0 1.563.213t1.137.474t1.05.488T12 18.4t1.25-.225t1.05-.488t1.15-.475T17 17q1.5 0 2.3.488t1.7.762q.425.125.713.413t.287.712t-.3.7t-.725.2q-1.3-.225-2.025-.775T17 18.95q-.7 0-1.213.213t-1.025.474t-1.15.488T12 20.35t-1.613-.225t-1.15-.488t-1.012-.475T7 18.95m0-4.45q-1.225 0-1.95.55t-2.025.775q-.425.075-.725-.2t-.3-.7t.287-.712T3 13.8q.9-.275 1.7-.763T7 12.55q.95 0 1.563.213t1.137.475t1.05.487t1.25.225t1.25-.225t1.05-.487t1.15-.475T17 12.55q1.5 0 2.3.488t1.7.762q.425.125.713.413t.287.712t-.3.7t-.725.2q-1.3-.225-2.025-.775T17 14.5q-.725 0-1.237.212t-1.026.475t-1.137.488t-1.6.225t-1.612-.225t-1.15-.488t-1.013-.474T7 14.5"/></svg>`,
    '〰': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#0284c7" d="M7 18.95q-1.225 0-1.95.55t-2.025.775q-.425.075-.725-.2t-.3-.7t.287-.712T3 18.25q.9-.275 1.7-.763T7 17q.95 0 1.563.213t1.137.474t1.05.488T12 18.4t1.25-.225t1.05-.488t1.15-.475T17 17q1.5 0 2.3.488t1.7.762q.425.125.713.413t.287.712t-.3.7t-.725.2q-1.3-.225-2.025-.775T17 18.95q-.7 0-1.213.213t-1.025.474t-1.15.488T12 20.35t-1.613-.225t-1.15-.488t-1.012-.475T7 18.95m0-4.45q-1.225 0-1.95.55t-2.025.775q-.425.075-.725-.2t-.3-.7t.287-.712T3 13.8q.9-.275 1.7-.763T7 12.55q.95 0 1.563.213t1.137.475t1.05.487t1.25.225t1.25-.225t1.05-.487t1.15-.475T17 12.55q1.5 0 2.3.488t1.7.762q.425.125.713.413t.287.712t-.3.7t-.725.2q-1.3-.225-2.025-.775T17 14.5q-.725 0-1.237.212t-1.026.475t-1.137.488t-1.6.225t-1.612-.225t-1.15-.488t-1.013-.474T7 14.5"/></svg>`,
    '🌑': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#334155"/><path d="M12 2a10 10 0 0 0 0 20" fill="#1e293b"/></svg>`,
    '🌓': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#475569"/><path d="M12 2a10 10 0 0 1 0 20z" fill="#fef08a"/></svg>`,
    '🌕': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#fef08a"/><circle cx="8" cy="9" r="1.5" fill="#fde047"/><circle cx="15" cy="14" r="2" fill="#fde047"/><circle cx="9" cy="15" r="1" fill="#fde047"/></svg>`,
    '🕳️': `<svg class="emoji-svg" viewBox="0 0 32 32"><ellipse cx="16" cy="22" rx="14" ry="8" fill="#94a3b8"/><ellipse cx="16" cy="22" rx="12" ry="6" fill="#1e1b4b"/></svg>`,
    '🕳': `<svg class="emoji-svg" viewBox="0 0 32 32"><ellipse cx="16" cy="22" rx="14" ry="8" fill="#94a3b8"/><ellipse cx="16" cy="22" rx="12" ry="6" fill="#1e1b4b"/></svg>`,
    '🇨🇭': `<svg class="emoji-svg" viewBox="0 0 24 24"><rect width="20" height="20" x="2" y="2" rx="4" fill="#ef4444"/><path fill="#ffffff" d="M10 5h4v4h4v4h-4v4h-4v-4H6V9h4z"/></svg>`,
    '🏯': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#ea580c" d="m223.68 66.15l-88-48.15a15.88 15.88 0 0 0-15.36 0l-88 48.17a16 16 0 0 0-8.32 14v95.64a16 16 0 0 0 8.32 14l88 48.17a15.88 15.88 0 0 0 15.36 0l88-48.17a16 16 0 0 0 8.32-14V80.18a16 16 0 0 0-8.32-14.03M128 120L47.65 76L128 32l80.35 44Zm8 99.64v-85.81l80-43.78v85.76Z"/></svg>`,
    '🖋️': `<svg class="emoji-svg" viewBox="0 0 20 20"><path fill="#334155" d="M11 9.27V0l6 11l-4 6H7l-4-6L9 0v9.27a2 2 0 1 0 2 0M6 18h8v2H6z"/><polygon points="9,0 11,0 10,4" fill="#eab308"/></svg>`,
    '🖋': `<svg class="emoji-svg" viewBox="0 0 20 20"><path fill="#334155" d="M11 9.27V0l6 11l-4 6H7l-4-6L9 0v9.27a2 2 0 1 0 2 0M6 18h8v2H6z"/><polygon points="9,0 11,0 10,4" fill="#eab308"/></svg>`,
    '🎭': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#f59e0b" d="M4.75 2A2.75 2.75 0 0 0 2 4.75v6.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-6.5A2.75 2.75 0 0 0 11.25 2zM3.5 4.75c0-.69.56-1.25 1.25-1.25h6.5c.69 0 1.25.56 1.25 1.25V6h-9z"/><path fill="#8b5cf6" d="M11.707 7h.793v.793L10.293 10H8.707zm-1.414 0l-3 3H5.707l3-3zm-6 3H3.5v-.793L5.707 7h1.586zM3.5 7.793V7h.793zM11.707 10l.793-.793V10z"/></svg>`,
    '🧹': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="none" stroke="#78350f" stroke-width="2" stroke-linecap="round" d="M15 12v7l-6 2v-8.5"/><path fill="#d97706" d="M4 4h16v2.172a2 2 0 0 1-.586 1.414L15 12H9L4.52 7.572A2 2 0 0 1 4 6.227z"/></svg>`,
    '🌿': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#10b981" d="M20.998 3v2c0 9.627-5.373 14-12 14H7.096c.212-3.012 1.15-4.835 3.598-7.001c1.204-1.065 1.102-1.68.509-1.327C7.119 13.102 5.09 16.386 5 21.63l-.003.37h-2c0-1.363.116-2.6.346-3.732Q2.999 16.327 2.998 13c0-5.523 4.477-10 10-10c2 0 4 1 8 0"/></svg>`,
    '🍄': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#fef3c7" d="M9 13c.366-2 1.866-3.873 4.5-5.6l3 5c-1.333 2.333-2.333 5.333-1 9H8c-1-3.667-.5-6.667 1-8.4z"/><path fill="#c2410c" d="M8.114 1.743C10.436-.58 15.525-.393 19.958 4.04s4.62 9.522 2.298 11.844c-.974.973-2.218 1.031-3.387.655c-.869-.28-1.778-.817-2.691-1.492q-.224.328-.468.742a49 49 0 0 0-.95 1.723l-.207.388c-.796 1.484-1.735 3.182-2.905 4.349c-.958.956-2.186 1.803-3.787 1.747c-1.57-.055-3.214-.969-5.051-2.81C.973 19.349.06 17.704.003 16.137c-.058-1.602.789-2.828 1.747-3.786c1.167-1.168 2.865-2.106 4.348-2.903l.384-.205a49 49 0 0 0 1.726-.953q.414-.244.743-.468c-.675-.913-1.213-1.823-1.493-2.692c-.376-1.168-.318-2.413.656-3.386"/></svg>`,
    '🐞': `<svg class="emoji-svg" viewBox="0 0 512 512"><path fill="#0f172a" d="M463.55 272.13H400v-48.2q0-4.32-.27-8.47c29.57-27.88 32.25-64.63 32.27-103c0-8.61-6.64-16-15.25-16.41A16 16 0 0 0 400 112c0 28-1.86 48.15-9.9 63.84c-19.22-41.15-65.78-63.91-134.1-63.91c-39.8 0-74.19 9.13-99.43 26.39c-14.9 10.19-26.2 22.91-33.7 37.72C114 160.65 112 141 112 112.46c0-8.61-6.6-16-15.2-16.44A16 16 0 0 0 80 112c0 37.63 2.61 73.73 32.44 101.63q-.43 5.06-.44 10.3v48.2H48.45c-8.61 0-16 6.62-16.43 15.23a16 16 0 0 0 16 16.77h64V320a143.3 143.3 0 0 0 10.39 53.69C96.74 396.64 80.18 422 80 463.34c0 8.74 6.62 16.3 15.36 16.65A16 16 0 0 0 112 464c0-27.66 9.1-44.71 26.17-61.32A144.37 144.37 0 0 0 220 459.42a16 16 0 0 0 20-15.49V192.45c0-8.61 6.62-16 15.23-16.43A16 16 0 0 1 272 192v251.93a16 16 0 0 0 20 15.49a144.4 144.4 0 0 0 81.82-56.74c17 16.54 26.09 33.52 26.17 60.95a16.27 16.27 0 0 0 15.1 16.37A16 16 0 0 0 432 464c0-41.68-16.6-67.23-42.39-90.31A143.3 143.3 0 0 0 400 320v-15.87h64a16 16 0 0 0 16-16.77c-.42-8.61-7.84-15.23-16.45-15.23"/><path fill="#ef4444" d="M144 200c0 88 48 160 112 160s112-72 112-160z"/><path fill="#0f172a" d="M256 190v170M200 240a16 16 0 1 0 0-32a16 16 0 0 0 0 32m112 0a16 16 0 1 0 0-32a16 16 0 0 0 0 32"/></svg>`,
    '🦅': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#b45309" d="M15 2a5 5 0 0 1 4.584 3H21a1 1 0 0 1 .832 1.555L20.28 8.883a1 1 0 0 0-.151.733l.14.774C21.275 15.914 17.03 21 11.415 21H3a1 1 0 0 1-.832-1.555l.991-1.486q.009-.016.019-.028l4.985-7.479l.009-.012l1.441-2.163A2.3 2.3 0 0 0 10 7a5 5 0 0 1 5-5m-2.5 8c-.818 0-2.044.393-2.5 1l-5 7.5c2.277-1.063 10-2 10-6a2.5 2.5 0 0 0-2.5-2.5"/><circle cx="15" cy="7" r="1.5" fill="#f59e0b"/></svg>`,
    '🦊': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#ea580c" d="M8 7a5 5 0 0 0-5 5c0 1.298 1.212 2 2.285 2h5.43C11.788 14 13 13.298 13 12a5 5 0 0 0-5-5"/><polygon points="2,2 5,7 1,8" fill="#ea580c"/><polygon points="14,2 11,7 15,8" fill="#ea580c"/><polygon points="3,3 4.5,6 2,6.5" fill="#f8fafc"/><polygon points="13,3 11.5,6 14,6.5" fill="#f8fafc"/><circle cx="8" cy="11.5" r="1" fill="#0f172a"/></svg>`,
    '🐸': `<svg class="emoji-svg" viewBox="0 0 32 32"><path fill="#16a34a" d="M21 7a3 3 0 0 0-2.625 1.563c-.34.199-1.023.632-1.781 1.468c-.934.016-2.676.086-4.657.719c-2.117.676-4.386 2.047-5.656 4.563c-.011.027-.05.035-.062.062c-.051.055-.535.555-1.063 1.344C4.606 17.547 4 18.633 4 19.906c0 .918.32 1.84 1 2.5c.223.219.512.371.813.5c-.118.157-.243.309-.344.469c-.23.36-.469.613-.469 1.281c0 .418.305.817.531.969s.387.21.563.25c.347.078.71.086 1.125.094c.832.011 1.914-.035 3.125-.094c2.426-.117 5.39-.223 7.5.125l.312-2c-1-.164-2.11-.23-3.218-.25c.613-.652 1.062-1.469 1.062-2.469c0-1.597-1.031-2.808-2.219-3.437C12.594 17.214 11.215 17 10 17v2c.941 0 2.07.215 2.844.625c.773.41 1.156.848 1.156 1.656c0 .653-.531 1.27-1.406 1.782c-.875.511-2.043.78-2.406.78v.032c-1.083.05-2.004.094-2.688.094c.105-.14.2-.266.313-.407c.492-.605 1-1.125 1-1.125l-1.47-1.375l-.03.063c-.504.148-.723.05-.938-.156S6 20.336 6 19.906c0-.531.395-1.386.844-2.062s.875-1.157.875-1.157l.125-.125l.062-.156c.93-2.062 2.774-3.148 4.657-3.75C14.444 12.055 16.305 12 17 12h.5l.313-.406c.136-.188.285-.32.437-.469C18.703 12.215 19.758 13 21 13c1.59 0 2.883-1.273 2.969-2.844c.457.114.91.266 1.281.469c.32.176.578.371.719.5c-.008.04-.016.02-.032.063c-.066.183-.203.398-.375.656c-.347.511-.921 1.101-1.937 1.5l-.625.25v.687c0 1.403-.125 4.852-2.063 6.219l1.157 1.625c2.808-1.984 2.843-5.563 2.843-7.25c1.043-.54 1.82-1.227 2.282-1.906c.273-.406.472-.785.593-1.125c.122-.34.188-.61.188-.938c0-.773-.383-.969-.688-1.25a5.6 5.6 0 0 0-1.125-.781c-.812-.441-1.835-.793-2.937-.844A3 3 0 0 0 21 7"/><circle cx="21" cy="10" r="1.5" fill="#facc15"/><circle cx="10" cy="10" r="1.5" fill="#facc15"/></svg>`,
    '🔮': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="11" r="7" fill="#8b5cf6" fill-opacity="0.25" stroke="#8b5cf6" stroke-width="2"/><path d="M7 19h10m-8 2h6" stroke="#64748b" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="9" r="1.5" fill="#c084fc"/></svg>`,
    '🤖': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 8V4H8" stroke="#64748b"/><rect width="16" height="12" x="4" y="8" rx="2" stroke="#06b6d4" fill="rgba(6, 182, 212, 0.15)"/><circle cx="9" cy="13" r="1.5" fill="#facc15"/><circle cx="15" cy="13" r="1.5" fill="#facc15"/><path d="M2 14h2m16 0h2" stroke="#64748b"/></svg>`,
    '📸': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#334155" fill-rule="evenodd" d="M7.574 4.336A3 3 0 0 1 10.07 3h3.86a3 3 0 0 1 2.496 1.336l.812 1.219A1 1 0 0 0 18.07 6H19a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h.93a1 1 0 0 0 .832-.445l.812-1.22z" clip-rule="evenodd"/><circle cx="12" cy="13" r="4.5" fill="#0ea5e9"/><circle cx="12" cy="13" r="2.5" fill="#0284c7"/><circle cx="19" cy="8" r="1" fill="#ef4444"/></svg>`,
    '🌸': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f472b6" d="M3 13a9 9 0 0 0 9 9c0-5-4.03-9-9-9m9-7.5A2.5 2.5 0 0 1 14.5 8a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 9.5 8A2.5 2.5 0 0 1 12 5.5m-6.4 4.75a2.5 2.5 0 0 0 2.5 2.5c.53 0 1.02-.17 1.4-.44v.19A2.5 2.5 0 0 0 12 15a2.5 2.5 0 0 0 2.5-2.5v-.19c.38.27.87.44 1.4.44a2.5 2.5 0 0 0 2.5-2.5c0-1-.59-1.85-1.43-2.25c.84-.4 1.43-1.26 1.43-2.25a2.5 2.5 0 0 0-2.5-2.5c-.53 0-1.02.16-1.4.44V3.5A2.5 2.5 0 0 0 12 1a2.5 2.5 0 0 0-2.5 2.5v.19c-.38-.28-.87-.44-1.4-.44a2.5 2.5 0 0 0-2.5 2.5c0 .99.59 1.85 1.43 2.25c-.84.4-1.43 1.25-1.43 2.25M12 22a9 9 0 0 0 9-9c-5 0-9 4-9 9"/><circle cx="12" cy="12" r="2.5" fill="#fde047"/></svg>`,
    '🍓': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 16.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0" fill="#ef4444" stroke="#dc2626" stroke-width="1.8"/><path d="M14 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" fill="#ef4444" stroke="#dc2626" stroke-width="1.8"/><path d="M9 13c.366 -2 1.866 -3.873 4.5 -5.6M17 15c-1.333 -2.333 -2.333 -5.333 -1 -9" stroke="#10b981" stroke-width="2"/><path d="M5 6c3.667 -2.667 7.333 -2.667 11 0c-3.667 2.667 -7.333 2.667 -11 0" stroke="#10b981" stroke-width="2"/></svg>`,
    '🌱': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#78350f" d="M2 22v-2s5-2 10-2s10 2 10 2v2z"/><path fill="#10b981" d="M11.3 9.1c-1.2-3.9-7.3-3-7.3-3s.2 7.8 5.9 6.6C9.5 9.8 8 9 8 9c2.8 0 3 3.4 3 3.4V17h2v-4.2s0-3.9 3-4.9c0 0-2 3-2 5c7 .7 7-8.9 7-8.9s-8.9-1-9.7 5.1"/></svg>`,
    '🦋': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#0284c7" d="M128 100.17a108 108 0 0 0-8-12.64V56a8 8 0 0 1 16 0v31.53a108 108 0 0 0-8 12.64m104.7-49.69C229 45.7 221.84 40 209 40c-16.85 0-38.46 11.28-57.81 30.16A140 140 0 0 0 136 87.53V180a8 8 0 0 1-16 0V87.53a140 140 0 0 0-15.15-17.37C85.49 51.28 63.88 40 47 40c-12.84 0-20 5.7-23.7 10.48c-6.82 8.77-12.18 24.08-.21 71.2c6.05 23.83 19.51 33 30.63 36.42A44 44 0 0 0 128 205.27a44 44 0 0 0 74.28-47.17c11.12-3.4 24.57-12.59 30.63-36.42c6.72-26.44 11.94-55.58-.21-71.2"/></svg>`,
    '🐛': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="none" stroke="#84cc16" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6.5 19H5a2 2 0 1 1 0-4h2.5c.465 0 .697 0 .89-.038a2 2 0 0 0 1.572-1.572c.038-.193.038-.425.038-.89c0-1.394 0-2.09.115-2.67a6 6 0 0 1 4.714-4.715C15.41 5 16.107 5 17.5 5H19a2 2 0 1 1 0 4h-2.5c-.465 0-.697 0-.89.038a2 2 0 0 0-1.572 1.572c-.038.193-.038.425-.038.89c0 1.394 0 2.09-.115 2.67a6 6 0 0 1-4.714 4.715C8.59 19 7.894 19 6.5 19M17 9V5m-3 7h-4m-3 3v4m2.5-4.5L12 17m2.5-7.5L12 7"/></svg>`,
    '❄️': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#38bdf8" d="M11 22v-1.825l-1.6 1.35L8.1 20l2.9-2.45v-3.8l-3.3 1.9l-.675 3.725l-1.975-.35l.375-2.075l-1.6.925l-1-1.725l1.6-.925L2.45 14.5l.675-1.875L6.7 13.9L10 12l-3.3-1.9l-3.575 1.3l-.675-1.9l1.975-.7l-1.6-.925l1-1.725l1.6.925L5.05 5l1.975-.35l.675 3.725l3.3 1.9v-3.8l-2.9-2.45L9.4 2.5L11 3.85V2h2v1.85l1.6-1.35l1.3 1.525l-2.9 2.45v3.8l3.275-1.9l.675-3.725l1.975.35l-.375 2.075l1.6-.925l1 1.725l-1.6.925l1.975.7l-.675 1.9l-3.575-1.3L14 12l3.275 1.9l3.575-1.275l.675 1.875l-1.975.725l1.6.925l-1 1.725l-1.6-.925l.375 2.075l-1.975.35l-.675-3.725L13 13.75v3.8L15.9 20l-1.3 1.525l-1.6-1.35V22z"/></svg>`,
    '❄': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#38bdf8" d="M11 22v-1.825l-1.6 1.35L8.1 20l2.9-2.45v-3.8l-3.3 1.9l-.675 3.725l-1.975-.35l.375-2.075l-1.6.925l-1-1.725l1.6-.925L2.45 14.5l.675-1.875L6.7 13.9L10 12l-3.3-1.9l-3.575 1.3l-.675-1.9l1.975-.7l-1.6-.925l1-1.725l1.6.925L5.05 5l1.975-.35l.675 3.725l3.3 1.9v-3.8l-2.9-2.45L9.4 2.5L11 3.85V2h2v1.85l1.6-1.35l1.3 1.525l-2.9 2.45v3.8l3.275-1.9l.675-3.725l1.975.35l-.375 2.075l1.6-.925l1 1.725l-1.6.925l1.975.7l-.675 1.9l-3.575-1.3L14 12l3.275 1.9l3.575-1.275l.675 1.875l-1.975.725l1.6.925l-1 1.725l-1.6-.925l.375 2.075l-1.975.35l-.675-3.725L13 13.75v3.8L15.9 20l-1.3 1.525l-1.6-1.35V22z"/></svg>`,
    '🎲': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="12" height="12" x="2" y="10" rx="2" ry="2" stroke="#64748b" fill="rgba(100, 116, 139, 0.15)"/><path d="m17.92 14l3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6" stroke="#64748b"/><circle cx="6" cy="18" r="1" fill="#ef4444"/><circle cx="10" cy="14" r="1" fill="#ef4444"/><circle cx="15" cy="6" r="1" fill="#ef4444"/><circle cx="18" cy="9" r="1" fill="#ef4444"/></g></svg>`,
    '⭐': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#f59e0b" d="m234.29 114.85l-45 38.83L203 211.75a16.4 16.4 0 0 1-24.5 17.82L128 198.49l-50.53 31.08A16.4 16.4 0 0 1 53 211.75l13.76-58.07l-45-38.83A16.46 16.46 0 0 1 31.08 86l59-4.76l22.76-55.08a16.36 16.36 0 0 1 30.27 0l22.75 55.08l59 4.76a16.46 16.46 0 0 1 9.37 28.86Z"/></svg>`,
    '✓': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#10b981"/><path fill="#ffffff" d="M16.95 8.38a1 1 0 0 0-1.415 0l-4.95 4.951l-2.121-2.121a1 1 0 1 0-1.414 1.414l2.829 2.828a1 1 0 0 0 1.414 0l5.656-5.657a1 1 0 0 0 0-1.414"/></svg>`,
    '🏕️': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="4" cy="4" r="2" fill="#f59e0b"/><path d="m14 5l3-3l3 3m-6 5l3-3l3 3m-3 4V2" stroke="#15803d"/><path d="M17 14H7l-5 8h20Zm-9 0v8m1-8l5 8" stroke="#f97316" fill="rgba(249, 115, 22, 0.15)"/></g></svg>`,
    '🏕': `<svg class="emoji-svg" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="4" cy="4" r="2" fill="#f59e0b"/><path d="m14 5l3-3l3 3m-6 5l3-3l3 3m-3 4V2" stroke="#15803d"/><path d="M17 14H7l-5 8h20Zm-9 0v8m1-8l5 8" stroke="#f97316" fill="rgba(249, 115, 22, 0.15)"/></g></svg>`,
    '🌊': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="none" stroke="#0284c7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.5 14.5L3.11612 15.1161C3.68206 15.6821 4.44964 16 5.25 16C6.05036 16 6.81794 15.6821 7.38388 15.1161L7.61612 14.8839C8.18206 14.3179 8.94964 14 9.75 14C10.5504 14 11.3179 14.3179 11.8839 14.8839L12.1161 15.1161C12.6821 15.6821 13.4496 16 14.25 16C15.0504 16 15.8179 15.6821 16.3839 15.1161L16.6161 14.8839C17.1821 14.3179 17.9496 14 18.75 14C19.5504 14 20.3179 14.3179 20.8839 14.8839L21.5 15.5M2.5 19.5L3.11612 20.1161C3.68206 20.6821 4.44964 21 5.25 21C6.05036 21 6.81794 20.6821 7.38388 20.1161L7.61612 19.8839C8.18206 19.3179 8.94964 19 9.75 19C10.5504 19 11.3179 19.3179 11.8839 19.8839L12.1161 20.1161C12.6821 20.6821 13.4496 21 14.25 21C15.0504 21 15.8179 20.6821 16.3839 20.1161L16.6161 19.8839C17.1821 19.3179 17.9496 19 18.75 19C19.5504 19 20.3179 19.3179 20.8839 19.8839L21.5 20.5"/><path fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" d="M12 11V3M12 3L9 6M12 3L15 6"/></svg>`,

    // Безопасность и ключи
    '🔑': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" d="M9.125 14.125Q10 13.25 10 12t-.875-2.125T7 9t-2.125.875T4 12t.875 2.125T7 15t2.125-.875M7 18q-2.5 0-4.25-1.75T1 12t1.75-4.25T7 6q2.025 0 3.538 1.15T12.65 10h8.375L23 11.975l-3.5 4L17 14l-2 2l-2-2h-.35q-.625 1.8-2.175 2.9T7 18"/></svg>`,
    '🔒': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#f59e0b" fill-rule="evenodd" d="M3 12a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zm10 2a1 1 0 1 0-2 0v3a1 1 0 1 0 2 0z" clip-rule="evenodd"/><path stroke="#94a3b8" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" fill="none" d="M8 10V7a4 4 0 0 1 4-4v0a4 4 0 0 1 4 4v3"/></svg>`,
    '🔓': `<svg class="emoji-svg" viewBox="0 0 24 24"><path stroke="#94a3b8" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" fill="none" d="M15.5 4.99C14.958 3.944 13.904 3 12 3C8.8 3 8 5.667 8 7v3"/><path fill="#10b981" fill-rule="evenodd" d="M3 12a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zm10 2a1 1 0 1 0-2 0v3a1 1 0 1 0 2 0z" clip-rule="evenodd"/></svg>`,

    // Импорт / Экспорт / Чтение / Чат
    '📤': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#0284c7" d="M74.34 77.66a8 8 0 0 1 0-11.32l48-48a8 8 0 0 1 11.32 0l48 48a8 8 0 0 1-11.32 11.32L136 43.31V128a8 8 0 0 1-16 0V43.31L85.66 77.66a8 8 0 0 1-11.32 0"/><path fill="#64748b" d="M240 136v64a16 16 0 0 1-16 16H32a16 16 0 0 1-16-16v-64a16 16 0 0 1 16-16h68a4 4 0 0 1 4 4v3.46c0 13.45 11 24.79 24.46 24.54A24 24 0 0 0 152 128v-4a4 4 0 0 1 4-4h68a16 16 0 0 1 16 16m-40 32a12 12 0 1 0-12 12a12 12 0 0 0 12-12"/></svg>`,
    '📥': `<svg class="emoji-svg" viewBox="0 0 256 256"><path fill="#10b981" d="M74.34 85.66a8 8 0 0 1 11.32-11.32L120 108.69V24a8 8 0 0 1 16 0v84.69l34.34-34.35a8 8 0 0 1 11.32 11.32l-48 48a8 8 0 0 1-11.32 0Z"/><path fill="#64748b" d="M240 136v64a16 16 0 0 1-16 16H32a16 16 0 0 1-16-16v-64a16 16 0 0 1 16-16h52.4a4 4 0 0 1 2.83 1.17L111 145a24 24 0 0 0 34 0l23.8-23.8a4 4 0 0 1 2.8-1.2H224a16 16 0 0 1 16 16m-40 32a12 12 0 1 0-12 12a12 12 0 0 0 12-12"/></svg>`,
    '📖': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linejoin="round"><path stroke="#2563eb" stroke-linecap="round" d="M8 4.981H6c-1.886 0-2.828 0-3.414.586S2 7.096 2 8.982v6.899c0 1.5 0 2.25.382 2.775a2 2 0 0 0 .443.443c.526.382 1.275.382 2.774.382h3.352a3.11 3.11 0 0 1 3.049 2.5v-15c-.293-.39-.44-.586-.599-.754a4 4 0 0 0-2.438-1.22c-.23-.026-.475-.026-.963-.026"/><path stroke="#2563eb" stroke-linecap="square" d="M12 6.981v15a3.11 3.11 0 0 1 3.05-2.5h3.35c1.499 0 2.248 0 2.774-.382q.257-.186.444-.443C22 18.13 22 17.38 22 15.88v-8.4c0-.465 0-.697-.038-.89a2 2 0 0 0-1.572-1.572c-.193-.038-.425-.038-.89-.038"/><path stroke="#38bdf8" stroke-linecap="round" d="M12 7.48s.77-4.237 5.017-5.273c.812-.198 1.218-.297 1.6.003S19 3 19 3.98v10.5c0 .87 0 1.304-.213 1.576c-.214.271-.733.398-1.77.651C12.77 17.743 12 21.981 12 21.981"/></svg>`,
    '💬': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="none" stroke="#0ea5e9" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path stroke="#0284c7" stroke-width="1.8" stroke-linecap="round" d="M7 11h10M7 15h6M7 7h8"/></svg>`,
    '👤': `<svg class="emoji-svg" viewBox="0 0 24 24"><circle cx="12" cy="8" r="5" fill="#64748b"/><path fill="#64748b" d="M12 14a8 8 0 0 0-8 8h16a8 8 0 0 0-8-8"/></svg>`,
    '📲': `<svg class="emoji-svg" viewBox="0 0 24 24"><path fill="#6366f1" d="M7 20.981a6.5 6.5 0 0 1-2.936-12a8.001 8.001 0 0 1 15.872 0a6.5 6.5 0 0 1-2.936 12V21H7z"/><path fill="#38bdf8" d="M13 12V8h-2v4H8l4 5l4-5z"/></svg>`,
    '📱': `<svg class="emoji-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="10" height="14" x="3" y="8" rx="2"/><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4"/><circle cx="8" cy="18" r="0.5" fill="#38bdf8"/></svg>`,
    '📦': `<svg class="emoji-svg" viewBox="0 0 32 32"><path fill="#b45309" d="M26 30H6a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2h3v2H6v12h20V16h-3v-2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2"/><path fill="#d97706" d="M13 20h6v2h-6zm7.59-11.41L17 12.17V2h-2v10.17l-3.59-3.58L10 10l6 6l6-6z"/></svg>`,
    '🐙': `<svg class="emoji-svg" viewBox="0 0 16 16"><path fill="#8b5cf6" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59c.4.07.55-.17.55-.38c0-.19-.01-.82-.01-1.49c-2.01.37-2.53-.49-2.69-.94c-.09-.23-.48-.94-.82-1.13c-.28-.15-.68-.52-.01-.53c.63-.01 1.08.58 1.23.82c.72 1.21 1.87.87 2.33.66c.07-.52.28-.87.51-1.07c-1.78-.2-3.64-.89-3.64-3.95c0-.87.31-1.59.82-2.15c-.08-.2-.36-1.02.08-2.12c0 0 .67-.21 2.2.82c.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82c.44 1.1.16 1.92.08 2.12c.51.56.82 1.27.82 2.15c0 3.07-1.87 3.75-3.65 3.95c.29.25.54.73.54 1.48c0 1.07-.01 1.93-.01 2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/></svg>`
  };

  // Регулярное выражение для поиска эмодзи в тексте
  const sortedKeys = Object.keys(EMOJI_MAP).sort((a, b) => b.length - a.length);
  const EMOJI_REGEX = new RegExp(sortedKeys.map(k => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'), 'g');

  // Базовые стили для SVG-иконок
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .emoji-svg-wrap {
      display: inline;
      align-items: center;
      justify-content: center;
      line-height: 1;
      vertical-align: middle;
    }
    .emoji-svg {
      display: inline-block;
      width: 1.15em;
      height: 1.15em;
      pointer-events: none;
      flex-shrink: 0;
      vertical-align: -0.15em;
      margin-right: 0.35em; /* Добавляет аккуратный естественный пробел после иконки в тексте */
    }

    /* На круглых и квадратных кнопках карты отступ не нужен, чтобы иконка была строго по центру */
    .floating-btn .emoji-svg, 
    .square-btn-top .emoji-svg,
    .quick-swap-top-btn .emoji-svg,
    .limit-reset-btn .emoji-svg,
    .compass-btn-top .emoji-svg,
    .qm-hud-btn .emoji-svg,
    .icon-btn .emoji-svg,
    .modal-close-x .emoji-svg {
      margin-right: 0 !important;
    }
    .floating-btn .emoji-svg-wrap, 
    .square-btn-top .emoji-svg-wrap {
      display: flex;
      width: 100%;
      height: 100%;
    }
    .floating-btn .emoji-svg, 
    .square-btn-top .emoji-svg {
      width: 1.35em;
      height: 1.35em;
      vertical-align: 0;
    }

    /* ОСНОВНОЙ ИНТЕРФЕЙС КАРТЫ: СОХРАНЯЕМ СТРОГИЙ МОНОХРОМ В ЦВЕТ КНОПКИ */
    .floating-btn .emoji-svg [fill]:not([fill="none"]),
    .square-btn-top .emoji-svg [fill]:not([fill="none"]),
    .quick-swap-top-btn .emoji-svg [fill]:not([fill="none"]),
    .limit-reset-btn .emoji-svg [fill]:not([fill="none"]),
    .topbar .emoji-svg [fill]:not([fill="none"]),
    .compass-btn-top .emoji-svg [fill]:not([fill="none"]) {
      fill: currentColor !important;
    }

    .floating-btn .emoji-svg [stroke]:not([stroke="none"]),
    .square-btn-top .emoji-svg [stroke]:not([stroke="none"]),
    .quick-swap-top-btn .emoji-svg [stroke]:not([stroke="none"]),
    .limit-reset-btn .emoji-svg [stroke]:not([stroke="none"]),
    .topbar .emoji-svg [stroke]:not([stroke="none"]),
    .compass-btn-top .emoji-svg [stroke]:not([stroke="none"]) {
      stroke: currentColor !important;
    }

    .floating-btn svg.emoji-svg[stroke],
    .square-btn-top svg.emoji-svg[stroke],
    .quick-swap-top-btn svg.emoji-svg[stroke],
    .limit-reset-btn svg.emoji-svg[stroke],
    .topbar svg.emoji-svg[stroke],
    .compass-btn-top svg.emoji-svg[stroke],
    .floating-btn .emoji-svg [stroke]:not([stroke="none"]),
    .square-btn-top .emoji-svg [stroke]:not([stroke="none"]),
    .quick-swap-top-btn .emoji-svg [stroke]:not([stroke="none"]),
    .limit-reset-btn .emoji-svg [stroke]:not([stroke="none"]),
    .topbar .emoji-svg [stroke]:not([stroke="none"]),
    .compass-btn-top .emoji-svg [stroke]:not([stroke="none"]) {
      stroke: currentColor !important;
    }
  `;
  document.head.appendChild(styleEl);

  /**
   * Заменяет текст узла на HTML со встроенными SVG
   */
  function parseTextNode(node) {
    const val = node.nodeValue;
    if (!val || !EMOJI_REGEX.test(val)) return;

    EMOJI_REGEX.lastIndex = 0;
    const parent = node.parentNode;
    if (!parent) return;

    const span = document.createElement('span');
    span.className = 'emoji-svg-wrap';
    span.innerHTML = val.replace(EMOJI_REGEX, (match) => EMOJI_MAP[match] || match);

    parent.replaceChild(span, node);
  }

  /**
   * Безопасный обход дерева элементов с пропуском карты
   */
  function replaceEmojiIn(root) {
    if (!root) return;

    // Пропуск карты (#map), инпутов, текстовых областей и элементов внутри SVG
    if (root.id === 'map' || (root.closest && (root.closest('#map') || root.closest('svg')))) return;

    const tagName = (root.tagName || '').toLowerCase();
    if (tagName === 'script' || tagName === 'style' || tagName === 'svg' || tagName === 'input' || tagName === 'textarea') {
      return;
    }

    if (nodeType(root) === 3) {
      parseTextNode(root);
      return;
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentNode;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest && (p.closest('#map') || p.closest('svg'))) {
            return NodeFilter.FILTER_REJECT;
          }
          const pTag = p.tagName.toLowerCase();
          if (pTag === 'script' || pTag === 'style' || pTag === 'svg' || pTag === 'textarea' || p.classList.contains('emoji-svg-wrap')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    nodes.forEach(parseTextNode);
  }

  function nodeType(n) {
    return n ? n.nodeType : 0;
  }

  // Наблюдатель за динамическим интерфейсом
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target && m.target.closest && m.target.closest('#map')) continue;

      if (m.type === 'characterData') {
        parseTextNode(m.target);
      } else if (m.type === 'childList') {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 3) {
            parseTextNode(node);
          } else if (node.nodeType === 1) {
            replaceEmojiIn(node);
          }
        });
      }
    }
  });

  function init() {
    replaceEmojiIn(document.body);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  WM.emojiSvg = {
    map: EMOJI_MAP,
    parse: replaceEmojiIn,
    get(emoji) {
      return EMOJI_MAP[emoji] || emoji;
    }
  };
})();