import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const translations = {
  en: {
    appName: "PushTalk",
    languageEnglish: "English",
    languageArabic: "العربية",
    signedInAs: "Signed in as",
    profile: "Profile",
    logout: "Log out",
    welcome: "Welcome to PushTalk",
    loginDescription:
      "Log in to your voice channels and pick up where the conversation left off.",
    registerDescription:
      "Create your account and join the conversation on PushTalk.",
    username: "Username",
    password: "Password",
    changePassword: "Change password",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmNewPassword: "Confirm new password",
    updatePassword: "Update password",
    passwordChanged: "Your password has been updated.",
    passwordChangeError: "Could not update your password.",
    currentPasswordInvalid: "The current password is incorrect.",
    passwordConfirmationMismatch: "The new passwords do not match.",
    passwordMustDiffer: "Choose a password different from the current one.",
    logIn: "Log in",
    register: "Register",
    createAccount: "Create an account",
    backToLogin: "Back to log in",
    somethingWentWrong: "Something went wrong.",
    createChannel: "Create a channel",
    channelName: "Channel name",
    channelDescription: "Description",
    channelImage: "Channel photo",
    channelNamePlaceholder: "e.g. team-alpha",
    channelDescriptionPlaceholder: "What is this channel for?",
    choosePhoto: "Choose photo",
    photoEdit: "Edit photo",
    create: "Create",
    channels: "Channels",
    loading: "Loading…",
    noChannels: "No channels yet. Create the first one.",
    open: "Open",
    join: "Join",
    member: "member",
    admin: "Admin",
    memberCount: "{count} members",
    members: "Members",
    online: "online",
    you: "you",
    channelCreateError: "Could not create the channel.",
    channelExists: "A channel with this name already exists.",
    noDescription: "No description yet",
    channelLoadError: "Could not load channels.",
    channelJoinError: "Could not join the channel.",
    invalidChannelName:
      "Channel names use 2–64 lowercase letters, digits, '-' or '_'.",
    channelCreated: "Channel created.",
    channelPhotoError:
      "The channel was created, but its photo could not be uploaded.",
    myChannels: "My channels",
    noOwnedChannels: "You haven't created any channels yet.",
    openChannel: "Open channel",
    manageChannel: "Manage channel",
    channelSettings: "Channel settings",
    channelSaveError: "Could not save channel changes.",
    channelDeleteError: "Could not delete this channel.",
    confirmDeleteChannel: "Delete this channel?",
    confirmDeleteChannelBody:
      "Delete #{name} and its voice messages? This can't be undone.",
    deleteChannel: "Delete channel",
    scrollToTop: "Back to top",
    channelsBack: "Channels",
    invalidChannel: "Invalid channel.",
    connectionConnecting: "Connecting…",
    connectionLive: "Live",
    connectionReconnecting: "Reconnecting…",
    connectionDisconnected: "Disconnected",
    retryIn: "retry in {seconds}s",
    clickEnableAudio: "Click to enable auto-play",
    waitingCount: "{count} waiting",
    otherTabNotice:
      "This channel is open in another tab. Auto-play happens there; you can still play messages manually.",
    holdLonger: "Hold the button a little longer (at least 0.5 s).",
    loadingMessages: "Loading messages…",
    noMessages: "No messages yet. Hold the button and say hi.",
    playUnheard: "Play {count} unheard",
    waitingRelease: "{count} message(s) waiting until you release",
    releaseToSend: "Release to send",
    startingMic: "Starting mic…",
    holdToTalk: "Hold to talk",
    startRecording: "Start recording",
    spaceHint: "or hold the Space bar · 0.5–60 s",
    senderYou: "You",
    messageNew: "new",
    messageQueued: "queued",
    messagePlaying: "Playing",
    playMessage: "Play message",
    retry: "Retry",
    uploading: "Uploading…",
    notSent: "Not sent",
    processing: "Processing…",
    failed: "Failed",
    sent: "Sent",
    played: "Played",
    delivered: "Delivered",
    profileTitle: "Your profile",
    displayName: "Name",
    changePhoto: "Change photo",
    saveChanges: "Save changes",
    cancel: "Cancel",
    profileSaved: "Your profile has been updated.",
    profileSaveError: "Could not update your profile.",
    profilePhotoTooLarge: "Choose a profile photo smaller than 2 MB.",
    profilePhotoUnsupported: "Choose a JPEG, PNG, or WebP image.",
    profilePhotoStorageError: "The server could not save your profile photo.",
    confirmLogoutTitle: "Log out of PushTalk?",
    confirmLogoutBody: "You can come back any time by logging in again.",
    confirm: "Log out",
    logoutSuccess: "You have logged out successfully.",
    logoutCancel: "Stay logged in",
    defaultAvatarAlt: "Default profile photo",
    channelPhotoAlt: "Channel photo",
    audioTooShort: "Recording was too short (min 0.5 s).",
    audioTooLong: "Recording was too long (max 60 s).",
    audioInvalid: "The recording was corrupted.",
    emptyFile: "The recording was empty.",
    fileTooLarge: "The recording is too large.",
    unsupportedMedia: "This audio format is not supported.",
    serverAudioError: "The server could not process this audio.",
    processingTimeout: "Processing took too long.",
    processingError: "Processing failed on the server.",
    queueUnavailable: "Processing queue unavailable. Try again.",
    uploadMissing: "The upload was lost on the server.",
    storageError: "The server could not store the audio.",
    processingFailed: "Processing failed.",
    networkError: "Cannot reach the server. Check your connection.",
    serverError: "The server had a problem. Please try again.",
    requestFailed: "Request failed ({status})",
    invalidCredentials: "The username or password is incorrect.",
    usernameTaken: "That username is already in use.",
    playedCount: "Played {count}",
    deliveredCount: "Delivered {count}",
    secureRecording:
      "Recording needs a secure page (https or localhost) in a modern browser.",
    recorderUnsupported: "This browser cannot record audio.",
    microphoneDenied:
      "Microphone permission was denied. Allow it in the browser site settings.",
    microphoneMissing: "No microphone was found.",
    microphoneBusy: "The microphone is in use by another application.",
    microphoneStartFailed: "Could not start recording.",
    recordingFailed: "Recording failed.",
    playbackError:
      "Couldn't play the message from {name}. Skipped to the next one.",
    uploadFailed: "Upload failed.",
    validationRequired: "{field} is required.",
    validationMinLength: "{field} must contain at least {count} characters.",
    validationMaxLength:
      "{field} must contain no more than {count} characters.",
    validationInvalid: "Check the {field} value.",
    usernameFormat: "Use letters, numbers, periods, underscores, or hyphens.",
    channelNameFormat:
      "Use lowercase English letters, numbers, underscores, or hyphens.",
  },
  ar: {
    appName: "PushTalk",
    languageEnglish: "الإنجليزية",
    languageArabic: "العربية",
    signedInAs: "تم تسجيل الدخول باسم",
    profile: "الملف الشخصي",
    logout: "تسجيل الخروج",
    welcome: "مرحبًا بك في بوش توك",
    loginDescription:
      "سجّل الدخول إلى قنواتك الصوتية، واستكمل محادثاتك من حيث توقفت.",
    registerDescription: "أنشئ حسابًا وانضم إلى المحادثات الصوتية على بوش توك.",
    username: "اسم المستخدم",
    password: "كلمة المرور",
    changePassword: "تغيير كلمة المرور",
    currentPassword: "كلمة المرور الحالية",
    newPassword: "كلمة المرور الجديدة",
    confirmNewPassword: "تأكيد كلمة المرور الجديدة",
    updatePassword: "تحديث كلمة المرور",
    passwordChanged: "تم تحديث كلمة المرور بنجاح.",
    passwordChangeError: "تعذر تحديث كلمة المرور.",
    currentPasswordInvalid: "كلمة المرور الحالية غير صحيحة.",
    passwordConfirmationMismatch: "كلمتا المرور الجديدتان غير متطابقتين.",
    passwordMustDiffer: "يجب اختيار كلمة مرور تختلف عن الحالية.",
    logIn: "تسجيل الدخول",
    register: "إنشاء حساب",
    createAccount: "ليس لديك حساب؟ أنشئ حسابًا جديدًا",
    backToLogin: "لديك حساب؟ العودة إلى تسجيل الدخول",
    somethingWentWrong: "حدث خطأ غير متوقع.",
    createChannel: "إنشاء قناة",
    channelName: "اسم القناة",
    channelDescription: "وصف القناة",
    channelImage: "صورة القناة",
    channelNamePlaceholder: "مثال: فريق-ألفا",
    channelDescriptionPlaceholder: "ما الغرض من هذه القناة؟",
    choosePhoto: "اختر صورة",
    photoEdit: "تعديل الصورة",
    create: "إنشاء",
    channels: "القنوات",
    loading: "جارٍ التحميل…",
    noChannels: "لا توجد قنوات بعد. أنشئ القناة الأولى.",
    open: "فتح",
    join: "انضمام",
    member: "عضو",
    admin: "مدير",
    memberCount: "{count} أعضاء",
    members: "الأعضاء",
    online: "متصلون",
    you: "أنت",
    channelCreateError: "تعذر إنشاء القناة.",
    channelExists: "اسم القناة مستخدم بالفعل.",
    noDescription: "لا يوجد وصف متاح.",
    channelLoadError: "تعذر تحميل القنوات.",
    channelJoinError: "تعذر الانضمام إلى القناة.",
    invalidChannelName:
      "يجب أن يتكون اسم القناة من 2 إلى 64 حرفًا إنجليزيًا صغيرًا أو رقمًا أو الرمز '-' أو '_'.",
    channelCreated: "تم إنشاء القناة بنجاح.",
    channelPhotoError: "أُنشئت القناة، لكن تعذر رفع صورتها.",
    myChannels: "قنواتي",
    noOwnedChannels: "لم تنشئ أي قنوات بعد.",
    openChannel: "فتح القناة",
    manageChannel: "إدارة القناة",
    channelSettings: "إعدادات القناة",
    channelSaveError: "تعذر حفظ تعديلات القناة.",
    channelDeleteError: "تعذر حذف القناة.",
    confirmDeleteChannel: "هل تريد حذف هذه القناة؟",
    confirmDeleteChannelBody:
      "هل تريد حذف القناة #{name} وتسجيلاتها الصوتية؟ لا يمكن التراجع عن هذا الإجراء.",
    deleteChannel: "حذف القناة",
    scrollToTop: "العودة إلى أعلى الصفحة",
    channelsBack: "القنوات",
    invalidChannel: "القناة غير صالحة.",
    connectionConnecting: "جارٍ الاتصال…",
    connectionLive: "متصل",
    connectionReconnecting: "جارٍ إعادة الاتصال…",
    connectionDisconnected: "غير متصل",
    retryIn: "إعادة المحاولة خلال {seconds} ثانية",
    clickEnableAudio: "انقر لتمكين التشغيل التلقائي",
    waitingCount: "{count} في قائمة الانتظار",
    otherTabNotice:
      "هذه القناة مفتوحة في علامة تبويب أخرى. يعمل التشغيل التلقائي هناك، ويمكنك تشغيل الرسائل يدويًا هنا.",
    holdLonger: "اضغط على الزر مدة أطول، نصف ثانية على الأقل.",
    loadingMessages: "جارٍ تحميل الرسائل…",
    noMessages: "لا توجد رسائل بعد. اضغط مطولًا على الزر وابدأ التحدث.",
    playUnheard: "تشغيل {count} رسالة غير مسموعة",
    waitingRelease: "{count} رسالة بانتظار إنهاء التسجيل",
    releaseToSend: "اترك الزر للإرسال",
    startingMic: "جارٍ تشغيل الميكروفون…",
    holdToTalk: "اضغط مطولًا للتحدث",
    startRecording: "بدء التسجيل",
    spaceHint: "أو اضغط مطولًا على مفتاح المسافة · من 0.5 إلى 60 ثانية",
    senderYou: "أنت",
    messageNew: "جديد",
    messageQueued: "قيد الانتظار",
    messagePlaying: "جارٍ التشغيل",
    playMessage: "تشغيل الرسالة",
    retry: "إعادة المحاولة",
    uploading: "جارٍ الرفع…",
    notSent: "تعذر الإرسال",
    processing: "جارٍ المعالجة…",
    failed: "فشل الإرسال",
    sent: "تم الإرسال",
    played: "تم الاستماع",
    delivered: "تم التسليم",
    profileTitle: "الملف الشخصي",
    displayName: "الاسم",
    changePhoto: "تغيير الصورة",
    saveChanges: "حفظ التغييرات",
    cancel: "إلغاء",
    profileSaved: "تم تحديث الملف الشخصي.",
    profileSaveError: "تعذر تحديث الملف الشخصي.",
    profilePhotoTooLarge: "يجب ألا يتجاوز حجم الصورة الشخصية 2 ميجابايت.",
    profilePhotoUnsupported: "اختر صورة بصيغة JPEG أو PNG أو WebP.",
    profilePhotoStorageError: "تعذر على الخادم حفظ الصورة الشخصية.",
    confirmLogoutTitle: "هل تريد تسجيل الخروج من بوش توك؟",
    confirmLogoutBody: "يمكنك العودة في أي وقت بتسجيل الدخول مجددًا.",
    confirm: "تسجيل الخروج",
    logoutSuccess: "تم تسجيل الخروج بنجاح.",
    logoutCancel: "البقاء مسجلًا للدخول",
    defaultAvatarAlt: "الصورة الشخصية الافتراضية",
    channelPhotoAlt: "صورة القناة",
    audioTooShort: "مدة التسجيل قصيرة جدًا؛ الحد الأدنى نصف ثانية.",
    audioTooLong: "مدة التسجيل تتجاوز الحد الأقصى، وهو 60 ثانية.",
    audioInvalid: "ملف التسجيل تالف.",
    emptyFile: "ملف التسجيل فارغ.",
    fileTooLarge: "حجم التسجيل يتجاوز الحد المسموح.",
    unsupportedMedia: "تنسيق الملف الصوتي غير مدعوم.",
    serverAudioError: "تعذر على الخادم معالجة التسجيل الصوتي.",
    processingTimeout: "استغرقت المعالجة وقتًا أطول من المتوقع.",
    processingError: "فشلت معالجة التسجيل على الخادم.",
    queueUnavailable: "خدمة معالجة التسجيلات غير متاحة. حاول مرة أخرى.",
    uploadMissing: "ملف التسجيل غير موجود على الخادم.",
    storageError: "تعذر على الخادم حفظ التسجيل الصوتي.",
    processingFailed: "فشلت معالجة التسجيل.",
    networkError: "تعذر الاتصال بالخادم. تحقق من اتصالك بالإنترنت.",
    serverError: "حدثت مشكلة في الخادم. حاول مرة أخرى.",
    requestFailed: "فشل الطلب ({status}).",
    invalidCredentials: "اسم المستخدم أو كلمة المرور غير صحيح.",
    usernameTaken: "اسم المستخدم مستخدم بالفعل.",
    playedCount: "تم الاستماع ({count})",
    deliveredCount: "تم التسليم ({count})",
    secureRecording:
      "يتطلب تسجيل الصوت استخدام متصفح حديث واتصال آمن (HTTPS أو localhost).",
    recorderUnsupported: "هذا المتصفح لا يدعم تسجيل الصوت.",
    microphoneDenied:
      "رُفض إذن استخدام الميكروفون. اسمح به من إعدادات الموقع في المتصفح.",
    microphoneMissing: "لم يتم العثور على ميكروفون.",
    microphoneBusy: "الميكروفون قيد الاستخدام في تطبيق آخر.",
    microphoneStartFailed: "تعذر بدء التسجيل.",
    recordingFailed: "فشل التسجيل الصوتي.",
    playbackError:
      "تعذر تشغيل رسالة {name}. تم تجاوزها والانتقال إلى الرسالة التالية.",
    uploadFailed: "فشل رفع التسجيل الصوتي.",
    validationRequired: "حقل {field} مطلوب.",
    validationMinLength: "يجب ألا يقل طول {field} عن {count} أحرف.",
    validationMaxLength: "يجب ألا يزيد طول {field} على {count} حرفًا.",
    validationInvalid: "تحقق من قيمة {field}.",
    usernameFormat:
      "استخدم الحروف والأرقام والنقطة والشرطة السفلية أو الواصلة فقط.",
    channelNameFormat:
      "استخدم الحروف الإنجليزية الصغيرة والأرقام والشرطة السفلية أو الواصلة فقط.",
  },
} as const;

export type Language = keyof typeof translations;
export type TranslationKey = keyof typeof translations.en;
export type TranslationValues = Record<string, string | number>;

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);
const LANGUAGE_STORAGE_KEY = "pushtalk.language";

function initialLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  const setLanguage = (next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // The selected language still applies for this session.
    }
  };

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, values = {}) =>
        Object.entries(values).reduce(
          (text, [name, replacement]) =>
            text.replaceAll(`{${name}}`, String(replacement)),
          translations[language][key] as string,
        ),
    }),
    [language],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context)
    throw new Error("useLanguage must be used inside <LanguageProvider>");
  return context;
}
