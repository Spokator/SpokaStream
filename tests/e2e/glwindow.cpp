// Un petit jeu OpenGL pour tester la capture de jeu sans dépendre d'un vrai jeu : une fenêtre dont la couleur tourne et un carré qui se déplace.
// Compilé par tests/e2e/capture-game.ts. Mêmes appels que GLFW : SwapBuffers est importé de gdi32.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <GL/gl.h>

static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_DESTROY) PostQuitMessage(0);
  return DefWindowProcW(window, message, w, l);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  WNDCLASSW kind = {};
  kind.lpfnWndProc = proc;
  kind.hInstance = instance;
  kind.lpszClassName = L"SpokaGlTest";
  kind.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  kind.style = CS_OWNDC;
  RegisterClassW(&kind);
  HWND window = CreateWindowW(L"SpokaGlTest", L"Jeu OpenGL d'essai", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 60, 60, 816, 639, nullptr, nullptr, instance, nullptr);
  HDC dc = GetDC(window);
  PIXELFORMATDESCRIPTOR format = {sizeof(format), 1, PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER, PFD_TYPE_RGBA, 32};
  SetPixelFormat(dc, ChoosePixelFormat(dc, &format), &format);
  wglMakeCurrent(dc, wglCreateContext(dc));
  for (DWORD frame = 0;; frame++) {
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) return 0;
      DispatchMessageW(&message);
    }
    float tone = (frame % 120) / 170.0f;
    glClearColor(tone, tone, tone, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    // Un carré blanc en bas à gauche : c'est lui qui dit si l'image arrive à l'endroit.
    glScissor(0, 0, 100, 100);
    glClearColor(1, 1, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    SwapBuffers(dc);
    Sleep(8);
  }
}
