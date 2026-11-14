using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace CafeOne
{
    internal static class CafeOneLauncher
    {
        private const string ReadyCheckArgs = "-c \"import fastapi, uvicorn, webview, prisma, PIL\"";
        private static readonly MessageBoxOptions RtlOpts = MessageBoxOptions.RightAlign | MessageBoxOptions.RtlReading;

        [STAThread]
        private static void Main()
        {
            string rootDir = AppDomain.CurrentDomain.BaseDirectory;
            string indexHtml = Path.Combine(rootDir, "frontend", "out", "index.html");
            if (!File.Exists(indexHtml))
            {
                MessageBox.Show(
                    "فایل‌های رابط کاربری (frontend\\out\\index.html) یافت نشدند.\nلطفاً ابتدا نسخه آماده کافه وان را دریافت یا نصب کنید.",
                    "خطا در اجرای کافه وان",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error,
                    MessageBoxDefaultButton.Button1,
                    RtlOpts
                );
                return;
            }

            string mainPy = Path.Combine(rootDir, "main.py");
            if (!File.Exists(mainPy))
            {
                MessageBox.Show(
                    "فایل اصلی برنامه (main.py) در پوشه کافه وان یافت نشد.",
                    "خطا در اجرای کافه وان",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error,
                    MessageBoxDefaultButton.Button1,
                    RtlOpts
                );
                return;
            }

            string pythonw = FindReadyPythonW(rootDir);
            if (string.IsNullOrEmpty(pythonw))
            {
                string installerExe = Path.Combine(rootDir, "CafeOne-Installer.exe");
                if (File.Exists(installerExe))
                {
                    DialogResult choice = MessageBox.Show(
                        "پیش‌نیازهای اجرای کافه وان هنوز روی این سیستم نصب نشده‌اند.\nآیا مایلید پنجره نصب (CafeOne-Installer.exe) باز شود؟",
                        "نصب کافه وان",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Question,
                        MessageBoxDefaultButton.Button1,
                        RtlOpts
                    );
                    if (choice == DialogResult.Yes)
                    {
                        Process.Start(new ProcessStartInfo(installerExe) { WorkingDirectory = rootDir });
                    }
                }
                else
                {
                    MessageBox.Show(
                        "محیط پایتون و وابستگی‌های کافه وان نصب نیستند.\nلطفاً ابتدا برنامه نصب (CafeOne-Installer.exe) یا setup_target_pc.bat را اجرا کنید.",
                        "پیش‌نیازها نصب نشده است",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning,
                        MessageBoxDefaultButton.Button1,
                        RtlOpts
                    );
                }
                return;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = pythonw;
                psi.Arguments = "\"main.py\"";
                psi.WorkingDirectory = rootDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "خطا هنگام راه‌اندازی کافه وان:\n" + ex.Message,
                    "کافه وان",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error,
                    MessageBoxDefaultButton.Button1,
                    RtlOpts
                );
            }
        }

        private static string FindReadyPythonW(string rootDir)
        {
            string[] venvDirs = new string[]
            {
                Path.Combine(rootDir, ".venv", "Scripts"),
                Path.Combine(rootDir, "venv", "Scripts"),
            };

            foreach (string dir in venvDirs)
            {
                string py = Path.Combine(dir, "python.exe");
                string pyw = Path.Combine(dir, "pythonw.exe");
                if (File.Exists(py) && CheckPackages(py))
                {
                    return File.Exists(pyw) ? pyw : py;
                }
            }

            string pathPython = ResolveSystemPython();
            if (!string.IsNullOrEmpty(pathPython) && CheckPackages(pathPython))
            {
                string folder = Path.GetDirectoryName(pathPython);
                string pyw = string.IsNullOrEmpty(folder) ? "pythonw.exe" : Path.Combine(folder, "pythonw.exe");
                return File.Exists(pyw) ? pyw : pathPython;
            }

            return null;
        }

        private static string ResolveSystemPython()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("python.exe", "-c \"import sys; print(sys.executable)\"");
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string line = p.StandardOutput.ReadLine();
                    p.WaitForExit(8000);
                    if (p.ExitCode == 0 && !string.IsNullOrEmpty(line))
                    {
                        string trimmed = line.Trim();
                        if (File.Exists(trimmed)) return trimmed;
                    }
                }
            }
            catch { }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("py.exe", "-3 -c \"import sys; print(sys.executable)\"");
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string line = p.StandardOutput.ReadLine();
                    p.WaitForExit(8000);
                    if (p.ExitCode == 0 && !string.IsNullOrEmpty(line))
                    {
                        string trimmed = line.Trim();
                        if (File.Exists(trimmed)) return trimmed;
                    }
                }
            }
            catch { }

            return null;
        }

        private static bool CheckPackages(string pythonExe)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(pythonExe, ReadyCheckArgs);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    if (!p.WaitForExit(15000))
                    {
                        try { p.Kill(); } catch { }
                        return false;
                    }
                    return p.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }
    }
}
