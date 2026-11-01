// La capture de jeu : ce fichier devient une DLL chargée dans le jeu, à la demande explicite de la personne.
// Elle lit chaque image OpenGL juste avant son affichage et la dépose en mémoire partagée. SpokaAudio n'a plus qu'à la reprendre.
// WGC force le curseur logiciel, invisible dans un jeu OpenGL en plein écran exclusif. Ici Windows ne voit aucune capture :
// le curseur reste matériel. OpenGL 64 bits seulement. Ne jamais l'étendre sans vérifier ce qu'en pense un anti-triche.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <GL/gl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define GL_BGRA 0x80E1
#define GL_PIXEL_PACK_BUFFER 0x88EB
#define GL_STREAM_READ 0x88E1
#define GL_READ_ONLY 0x88B8
#define GL_PIXEL_PACK_BUFFER_BINDING 0x88ED
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_READ_FRAMEBUFFER_BINDING 0x8CAA
#define GL_PACK_ROW_LENGTH 0x0D02
#define GL_PACK_SKIP_PIXELS 0x0D04
#define GL_PACK_SKIP_ROWS 0x0D03

typedef ptrdiff_t GLsizeiptr;
typedef void(APIENTRY* GenBuffers)(GLsizei, GLuint*);
typedef void(APIENTRY* BindBuffer)(GLenum, GLuint);
typedef void(APIENTRY* BufferData)(GLenum, GLsizeiptr, const void*, GLenum);
typedef void*(APIENTRY* MapBuffer)(GLenum, GLenum);
typedef GLboolean(APIENTRY* UnmapBuffer)(GLenum);
typedef void(APIENTRY* BindFramebuffer)(GLenum, GLuint);
typedef BOOL(WINAPI* SwapFunction)(HDC);

// Doit rester identique à GameCapture.cs.
static const uint32_t kMagic = 0x53504B47;
static const int kMaxWidth = 3840;
static const int kMaxHeight = 2160;
static const size_t kHeaderBytes = 64;
static const size_t kSlotBytes = (size_t)kMaxWidth * kMaxHeight * 4;

#pragma pack(push, 1)
struct Shared {
  uint32_t magic;
  volatile LONG stop;
  volatile LONG intervalMicroseconds;
  /** Le dernier emplacement complet. */
  volatile LONG latest;
  /** L'emplacement que le lecteur est en train de copier, ou -1. */
  volatile LONG reading;
  int32_t width[2];
  int32_t height[2];
  volatile LONG heartbeat;
};
#pragma pack(pop)

static const int kBuffers = 3;

static Shared* shared;
static HANDLE frameEvent;
static GLuint buffers[kBuffers];
static bool bufferFilled[kBuffers];
static int bufferWidth, bufferHeight, nextBuffer;
static bool glReady, glFailed;
static GenBuffers genBuffers;
static BindBuffer bindBuffer;
static BufferData bufferData;
static MapBuffer mapBuffer;
static UnmapBuffer unmapBuffer;
static BindFramebuffer bindFramebuffer;
static LARGE_INTEGER frequency, lastFrame;
static SwapFunction realSwapBuffers, realWglSwapBuffers;
static DWORD lastAttach, lastCheck;

// Recopier 8 Mo dans le fil du jeu lui coûtait 2 ms par image (mesuré : 18 % d'images en moins). Un fil à part s'en charge, comme dans OBS.
enum CopyState : LONG { kCopyIdle, kCopyRunning, kCopyDone };
static volatile LONG copyState = kCopyIdle;
static HANDLE copyWake;
static const void* copySource;
static int copySlot, copyWidth, copyHeight;
/** Le tampon que le fil de copie lit encore : il reste ouvert jusqu'à ce que le fil du jeu le referme. */
static int mappedBuffer = -1;

static void attach() {
  if (shared) return;
  // Le lecteur crée la mémoire avant de nous charger. Une capture relancée la rouvre sous le même nom.
  DWORD now = GetTickCount();
  if (now - lastAttach < 1000) return;
  lastAttach = now;
  wchar_t name[64];
  swprintf(name, 64, L"Local\\SpokaGameFrames-%lu", GetCurrentProcessId());
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  if (!mapping) return;
  void* view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0);
  CloseHandle(mapping);
  if (!view) return;
  if (((Shared*)view)->magic != kMagic) {
    UnmapViewOfFile(view);
    return;
  }
  swprintf(name, 64, L"Local\\SpokaGameFrame-%lu", GetCurrentProcessId());
  frameEvent = OpenEventW(EVENT_MODIFY_STATE, FALSE, name);
  shared = (Shared*)view;
}

static void detach() {
  UnmapViewOfFile((void*)shared);
  if (frameEvent) CloseHandle(frameEvent);
  shared = nullptr;
  frameEvent = nullptr;
}

static bool loadGl() {
  if (glReady) return true;
  if (glFailed) return false;
  genBuffers = (GenBuffers)wglGetProcAddress("glGenBuffers");
  bindBuffer = (BindBuffer)wglGetProcAddress("glBindBuffer");
  bufferData = (BufferData)wglGetProcAddress("glBufferData");
  mapBuffer = (MapBuffer)wglGetProcAddress("glMapBuffer");
  unmapBuffer = (UnmapBuffer)wglGetProcAddress("glUnmapBuffer");
  bindFramebuffer = (BindFramebuffer)wglGetProcAddress("glBindFramebuffer");
  if (!genBuffers || !bindBuffer || !bufferData || !mapBuffer || !unmapBuffer || !bindFramebuffer) {
    glFailed = true;
    return false;
  }
  genBuffers(kBuffers, buffers);
  glReady = true;
  return true;
}

static DWORD WINAPI copyLoop(void*) {
  for (;;) {
    WaitForSingleObject(copyWake, INFINITE);
    memcpy((uint8_t*)shared + kHeaderBytes + copySlot * kSlotBytes, copySource, (size_t)copyWidth * copyHeight * 4);
    shared->width[copySlot] = copyWidth;
    shared->height[copySlot] = copyHeight;
    InterlockedExchange(&shared->latest, copySlot);
    if (frameEvent) SetEvent(frameEvent);
    InterlockedExchange(&copyState, kCopyDone);
  }
}

/** Referme le tampon d'une copie finie. Seul le fil du jeu peut parler à OpenGL. */
static void closeCopy() {
  if (copyState != kCopyDone) return;
  bindBuffer(GL_PIXEL_PACK_BUFFER, buffers[mappedBuffer]);
  unmapBuffer(GL_PIXEL_PACK_BUFFER);
  mappedBuffer = -1;
  InterlockedExchange(&copyState, kCopyIdle);
}

/** Confie l'image la plus ancienne déjà lue par la carte au fil de copie. Lire sans attendre garde le jeu fluide : deux images de retard au plus. */
static void deliver(int index, int width, int height) {
  if (copyState != kCopyIdle) return;
  LONG latest = shared->latest;
  int slot = latest == 0 ? 1 : 0;
  // Le lecteur est encore sur cet emplacement : on saute cette image plutôt que de la lui écrire dessus.
  if (shared->reading == slot) return;
  bindBuffer(GL_PIXEL_PACK_BUFFER, buffers[index]);
  void* pixels = mapBuffer(GL_PIXEL_PACK_BUFFER, GL_READ_ONLY);
  if (!pixels) return;
  copySource = pixels;
  copySlot = slot;
  copyWidth = width;
  copyHeight = height;
  mappedBuffer = index;
  InterlockedExchange(&copyState, kCopyRunning);
  SetEvent(copyWake);
}

/**
 * Windows retire le nom de la mémoire dès que le lecteur la ferme, même si on la garde ouverte : la capture suivante en crée une autre.
 * Rester sur l'ancienne ferait écrire le jeu dans le vide, y compris si SpokaAudio a planté sans rien dire.
 */
static bool readerGone() {
  if (shared->stop) return true;
  DWORD now = GetTickCount();
  if (now - lastCheck < 1000) return false;
  lastCheck = now;
  wchar_t name[64];
  swprintf(name, 64, L"Local\\SpokaGameFrames-%lu", GetCurrentProcessId());
  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, name);
  if (!mapping) return true;
  CloseHandle(mapping);
  return false;
}

static void capture(HDC dc) {
  attach();
  if (!shared) return;
  InterlockedIncrement(&shared->heartbeat);
  if (readerGone()) {
    // La copie écrit encore dans cette mémoire : on la lâchera à l'image suivante.
    if (copyState != kCopyRunning) detach();
    return;
  }
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  LONGLONG elapsed = (now.QuadPart - lastFrame.QuadPart) * 1000000 / frequency.QuadPart;
  // Le jeu ne tombe jamais pile sur l'échéance : sans cette marge, un jeu à 60 i/s capturé à 60 i/s sauterait une image sur deux.
  if (elapsed < shared->intervalMicroseconds * 3 / 4) return;
  lastFrame = now;

  HWND window = WindowFromDC(dc);
  RECT client;
  if (!window || !GetClientRect(window, &client)) return;
  int width = client.right, height = client.bottom;
  if (width <= 0 || height <= 0 || width > kMaxWidth || height > kMaxHeight) return;
  if (!wglGetCurrentContext() || !loadGl()) return;

  // Tout ce qu'on touche est remis en place : le jeu ne doit jamais s'apercevoir de notre passage.
  GLint oldPack = 0, oldFramebuffer = 0, oldRead = 0, oldAlign = 0, oldRow = 0, oldSkipPixels = 0, oldSkipRows = 0;
  glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &oldPack);
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &oldFramebuffer);
  glGetIntegerv(GL_READ_BUFFER, &oldRead);
  glGetIntegerv(GL_PACK_ALIGNMENT, &oldAlign);
  glGetIntegerv(GL_PACK_ROW_LENGTH, &oldRow);
  glGetIntegerv(GL_PACK_SKIP_PIXELS, &oldSkipPixels);
  glGetIntegerv(GL_PACK_SKIP_ROWS, &oldSkipRows);

  closeCopy();
  bool resized = width != bufferWidth || height != bufferHeight;
  // Ce tampon est encore lu par la copie, ou la fenêtre change de taille pendant ce temps : on laisse passer cette image.
  bool busy = mappedBuffer >= 0 && (resized || mappedBuffer == nextBuffer);
  if (resized && !busy) {
    for (int i = 0; i < kBuffers; i++) {
      bindBuffer(GL_PIXEL_PACK_BUFFER, buffers[i]);
      bufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)width * height * 4, nullptr, GL_STREAM_READ);
      bufferFilled[i] = false;
    }
    bufferWidth = width;
    bufferHeight = height;
    nextBuffer = 0;
  }

  bindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glReadBuffer(GL_BACK);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glPixelStorei(GL_PACK_ROW_LENGTH, 0);
  glPixelStorei(GL_PACK_SKIP_PIXELS, 0);
  glPixelStorei(GL_PACK_SKIP_ROWS, 0);

  if (!busy) {
    int index = nextBuffer;
    // On lit dans le tampon le plus ancien. Le suivant est prêt : c'est lui qu'on donne à copier.
    bindBuffer(GL_PIXEL_PACK_BUFFER, buffers[index]);
    glReadPixels(0, 0, width, height, GL_BGRA, GL_UNSIGNED_BYTE, nullptr);
    bufferFilled[index] = true;
    nextBuffer = (index + 1) % kBuffers;
    if (bufferFilled[nextBuffer]) deliver(nextBuffer, width, height);
  }

  bindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)oldPack);
  bindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)oldFramebuffer);
  glReadBuffer((GLenum)oldRead);
  glPixelStorei(GL_PACK_ALIGNMENT, oldAlign);
  glPixelStorei(GL_PACK_ROW_LENGTH, oldRow);
  glPixelStorei(GL_PACK_SKIP_PIXELS, oldSkipPixels);
  glPixelStorei(GL_PACK_SKIP_ROWS, oldSkipRows);
  while (glGetError() != GL_NO_ERROR) {
  }
}

static BOOL WINAPI hookSwapBuffers(HDC dc) {
  capture(dc);
  return realSwapBuffers(dc);
}

static BOOL WINAPI hookWglSwapBuffers(HDC dc) {
  capture(dc);
  return realWglSwapBuffers(dc);
}

/** Remplace une entrée de la table d'imports d'un module. Pas de code réécrit dans Windows : c'est la méthode la moins intrusive. */
static void patchImports(HMODULE module) {
  uint8_t* base = (uint8_t*)module;
  IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)base;
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
  IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
  IMAGE_DATA_DIRECTORY directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
  if (!directory.VirtualAddress) return;
  for (IMAGE_IMPORT_DESCRIPTOR* import = (IMAGE_IMPORT_DESCRIPTOR*)(base + directory.VirtualAddress); import->Name; import++) {
    const char* library = (const char*)(base + import->Name);
    bool gdi = _stricmp(library, "gdi32.dll") == 0;
    bool wgl = _stricmp(library, "opengl32.dll") == 0;
    if (!gdi && !wgl) continue;
    if (!import->OriginalFirstThunk) continue;
    IMAGE_THUNK_DATA* names = (IMAGE_THUNK_DATA*)(base + import->OriginalFirstThunk);
    IMAGE_THUNK_DATA* slots = (IMAGE_THUNK_DATA*)(base + import->FirstThunk);
    for (; names->u1.AddressOfData; names++, slots++) {
      if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
      const char* name = ((IMAGE_IMPORT_BY_NAME*)(base + names->u1.AddressOfData))->Name;
      void* replacement = nullptr;
      if (gdi && strcmp(name, "SwapBuffers") == 0) {
        if (!realSwapBuffers) realSwapBuffers = (SwapFunction)slots->u1.Function;
        replacement = (void*)hookSwapBuffers;
      } else if (wgl && strcmp(name, "wglSwapBuffers") == 0) {
        if (!realWglSwapBuffers) realWglSwapBuffers = (SwapFunction)slots->u1.Function;
        replacement = (void*)hookWglSwapBuffers;
      }
      if (!replacement || (void*)slots->u1.Function == replacement) continue;
      DWORD old;
      if (VirtualProtect(&slots->u1.Function, sizeof(void*), PAGE_READWRITE, &old)) {
        InterlockedExchangePointer((void**)&slots->u1.Function, replacement);
        VirtualProtect(&slots->u1.Function, sizeof(void*), old, &old);
      }
    }
  }
}

static DWORD WINAPI watch(void* self) {
  QueryPerformanceFrequency(&frequency);
  copyWake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE copier = CreateThread(nullptr, 0, copyLoop, nullptr, 0, nullptr);
  if (copier) CloseHandle(copier);
  // Un jeu charge ses bibliothèques au fil de l'eau : Java en particulier ne charge sa fenêtre qu'après le démarrage.
  for (;;) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snapshot != INVALID_HANDLE_VALUE) {
      MODULEENTRY32W entry = {sizeof(entry)};
      for (BOOL more = Module32FirstW(snapshot, &entry); more; more = Module32NextW(snapshot, &entry)) {
        if (entry.hModule != (HMODULE)self) patchImports(entry.hModule);
      }
      CloseHandle(snapshot);
    }
    Sleep(2000);
  }
}

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, void*) {
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  DisableThreadLibraryCalls(self);
  // Le verrou du chargeur est tenu ici : tout le travail se fait sur un autre fil.
  HANDLE thread = CreateThread(nullptr, 0, watch, self, 0, nullptr);
  if (thread) CloseHandle(thread);
  return TRUE;
}
