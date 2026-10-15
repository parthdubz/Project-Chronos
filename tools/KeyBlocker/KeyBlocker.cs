// KeyBlocker: blocks the Windows keys and the Tab key on this PC when the HOST says so.
//
// How it works
//   The program sits in the tray and asks the Chronos server every 2 seconds whether the keys
//   should be locked. The host flips that switch in the admin portal (Key Blocker tab), so one
//   click locks or unlocks every laptop that runs this program.
//
// Server address (first one found wins)
//   1. a command-line argument:       KeyBlocker.exe http://192.168.1.10:8000
//   2. a file named server.txt next to the exe, containing the same address on its first line
//
// Options
//   /keeptab      when locked, block only Alt+Tab / Ctrl+Tab / Win+Tab (plain Tab keeps working,
//                 so forms can still be filled with Tab). Default: every Tab press is blocked.
//   /standalone   no server: block the keys for as long as the program runs (old behaviour).
//
// Safety
//   * If the server cannot be reached 3 times in a row the keys are FREED (fail-open): a network
//     problem can never leave a player locked out.
//   * Opening the program a second time stops the running copy. Tray icon > "Exit" does too.
//   * No admin rights needed. If the program is killed or the PC restarts, the keys work again.
//   * Ctrl+Alt+Del and (usually) Win+L cannot be blocked by any program.
//
// Build: build.bat   (uses the C# compiler that ships with Windows)

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class KeyBlocker
{
    const string VERSION = "2.0";

    const int WH_KEYBOARD_LL = 13;
    const int VK_TAB = 0x09;
    const int VK_CONTROL = 0x11;
    const int VK_MENU = 0x12; // Alt
    const int VK_LWIN = 0x5B;
    const int VK_RWIN = 0x5C;
    const uint LLKHF_ALTDOWN = 0x20;

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT
    {
        public uint vkCode, scanCode, flags, time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    // kept in static fields so the delegate is never garbage collected while hooked
    static LowLevelKeyboardProc proc = HookCallback;
    static IntPtr hook = IntPtr.Zero;

    static volatile bool locked = false;         // the switch: true = block the keys now
    static volatile bool keepPlainTab = false;
    static volatile int failures = 0;            // consecutive failed polls
    static volatile bool everConnected = false;
    static string serverUrl = "";
    static bool standalone = false;

    static bool Down(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && locked)
        {
            var key = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));

            // Windows keys: swallowed (key down and key up)
            if (key.vkCode == VK_LWIN || key.vkCode == VK_RWIN)
                return (IntPtr)1;

            if (key.vkCode == VK_TAB)
            {
                if (!keepPlainTab)
                    return (IntPtr)1;
                // /keeptab: only the "switch window / tab" combinations are blocked
                bool alt = (key.flags & LLKHF_ALTDOWN) != 0 || Down(VK_MENU);
                bool ctrl = Down(VK_CONTROL);
                bool win = Down(VK_LWIN) || Down(VK_RWIN);
                if (alt || ctrl || win)
                    return (IntPtr)1;
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    // ------------------------------------------------------------------ server polling

    static void Poll(object state)
    {
        try
        {
            string url = serverUrl.TrimEnd('/') + "/api/security/keys-state?name=" +
                         Uri.EscapeDataString(Environment.MachineName) +
                         "&blocking=" + (locked ? "1" : "0") +
                         "&v=" + VERSION;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            req.Proxy = null;
            req.UserAgent = "KeyBlocker/" + VERSION;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
            {
                string body = reader.ReadToEnd();
                // tiny JSON read: {"locked":true,...}
                string flat = body.Replace(" ", "");
                locked = flat.IndexOf("\"locked\":true", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            failures = 0;
            everConnected = true;
        }
        catch
        {
            failures = failures + 1;
            if (failures >= 3) locked = false; // fail-open: never leave a player locked out
        }
    }

    static string ReadServerUrl(string[] args)
    {
        foreach (var a in args)
            if (a.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                a.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                return a.Trim();
        try
        {
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string file = Path.Combine(dir, "server.txt");
            if (File.Exists(file))
                foreach (var line in File.ReadAllLines(file))
                {
                    string t = line.Trim();
                    if (t.Length > 0 && !t.StartsWith("#"))
                    {
                        if (!t.StartsWith("http", StringComparison.OrdinalIgnoreCase)) t = "http://" + t;
                        return t;
                    }
                }
        }
        catch { }
        return "";
    }

    // ------------------------------------------------------------------ main

    [STAThread]
    static void Main(string[] args)
    {
        foreach (var a in args)
        {
            if (a.Equals("/keeptab", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--keeptab", StringComparison.OrdinalIgnoreCase))
                keepPlainTab = true;
            if (a.Equals("/standalone", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--standalone", StringComparison.OrdinalIgnoreCase))
                standalone = true;
        }

        bool first;
        using (var running = new Mutex(true, @"Local\ChronosKeyBlocker.Running", out first))
        using (var stopSignal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\ChronosKeyBlocker.Stop"))
        {
            if (!first)
            {
                // already running: this launch is the "stop it" request
                stopSignal.Set();
                return;
            }

            serverUrl = ReadServerUrl(args);
            if (!standalone && serverUrl.Length == 0)
            {
                MessageBox.Show(
                    "KeyBlocker does not know the Chronos server.\n\n" +
                    "Create a file named server.txt next to KeyBlocker.exe with the server address on the first line, " +
                    "for example:\n    http://192.168.1.10:8000\n\n" +
                    "or start it as:  KeyBlocker.exe http://192.168.1.10:8000",
                    "Key Blocker", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (standalone) locked = true;

            using (var curModule = Process.GetCurrentProcess().MainModule)
                hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
            if (hook == IntPtr.Zero)
            {
                MessageBox.Show("Could not install the keyboard hook (error " + Marshal.GetLastWin32Error() + ").",
                    "Key Blocker", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Application.EnableVisualStyles();
            var menu = new ContextMenuStrip();
            var statusItem = menu.Items.Add("Starting...");
            statusItem.Enabled = false;
            menu.Items.Add("Exit (keys are freed)", null, (s, e) => Application.ExitThread());
            var tray = new NotifyIcon
            {
                Icon = SystemIcons.Information,
                Text = "Key Blocker",
                ContextMenuStrip = menu,
                Visible = true,
            };

            System.Threading.Timer poller = null;
            if (!standalone)
                poller = new System.Threading.Timer(Poll, null, 0, 2000);

            string lastText = "";
            var ui = new System.Windows.Forms.Timer { Interval = 300 };
            ui.Tick += (s, e) =>
            {
                if (stopSignal.WaitOne(0)) { Application.ExitThread(); return; }

                string what = keepPlainTab ? "Windows keys + Alt/Ctrl/Win+Tab" : "Windows keys + Tab";
                string text;
                Icon icon;
                if (standalone)
                {
                    text = what + " BLOCKED (standalone)";
                    icon = SystemIcons.Shield;
                }
                else if (!everConnected && failures == 0)
                {
                    text = "Connecting to " + serverUrl + " ...";
                    icon = SystemIcons.Information;
                }
                else if (failures >= 3)
                {
                    text = "Server unreachable - keys are FREE";
                    icon = SystemIcons.Warning;
                }
                else if (locked)
                {
                    text = what + " are LOCKED by the host";
                    icon = SystemIcons.Shield;
                }
                else
                {
                    text = "Keys are free (host has not locked them)";
                    icon = SystemIcons.Information;
                }

                if (text != lastText)
                {
                    lastText = text;
                    tray.Icon = icon;
                    tray.Text = ("Key Blocker: " + text).Substring(0, Math.Min(63, ("Key Blocker: " + text).Length));
                    statusItem.Text = text;
                    if (everConnected || standalone || failures >= 3)
                        tray.ShowBalloonTip(1800, "Key Blocker", text, ToolTipIcon.Info);
                }
            };
            ui.Start();

            Application.Run();

            ui.Stop();
            if (poller != null) poller.Dispose();
            UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
            tray.Visible = false;
            tray.Dispose();
        }
    }
}
