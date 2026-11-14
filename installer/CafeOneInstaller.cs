using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CafeOne
{
    public sealed class InstallerForm : Form
    {
        private readonly string rootDir;
        private readonly CheckBox chkDesktop;
        private readonly CheckBox chkStartMenu;
        private readonly CheckBox chkLaunchAfter;
        private readonly ProgressBar progressBar;
        private readonly Label lblStatus;
        private readonly TextBox txtLog;
        private readonly Button btnInstall;
        private readonly Button btnClose;
        private bool isInstalling;
        private bool installSucceeded;

        public InstallerForm()
        {
            this.rootDir = AppDomain.CurrentDomain.BaseDirectory;
            this.Text = "نصب و راه‌اندازی کافه وان - Cafe One Setup";
            this.ClientSize = new Size(560, 440);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.RightToLeft = RightToLeft.Yes;
            this.RightToLeftLayout = true;
            this.BackColor = Color.FromArgb(24, 15, 10);
            this.ForeColor = Color.FromArgb(245, 236, 226);
            this.Font = new Font("Tahoma", 9.5F, FontStyle.Regular);

            string iconPath = Path.Combine(this.rootDir, "assets", "cafe-one.ico");
            if (File.Exists(iconPath))
            {
                try { this.Icon = new Icon(iconPath); } catch { }
            }

            Panel headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = 84;
            headerPanel.BackColor = Color.FromArgb(38, 22, 14);
            headerPanel.Padding = new Padding(18, 14, 18, 10);

            Label lblTitle = new Label();
            lblTitle.Text = "نصب و پیکربندی سامانه مدیریت کافه وان";
            lblTitle.Font = new Font("Tahoma", 12.5F, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(243, 198, 143);
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(18, 14);

            Label lblSub = new Label();
            lblSub.Text = "نصب وابستگی‌ها، آماده‌سازی پایگاه‌داده و ایجاد آیکون اجرا بدون نیاز به CMD";
            lblSub.Font = new Font("Tahoma", 9F, FontStyle.Regular);
            lblSub.ForeColor = Color.FromArgb(215, 196, 178);
            lblSub.AutoSize = true;
            lblSub.Location = new Point(18, 46);

            headerPanel.Controls.Add(lblTitle);
            headerPanel.Controls.Add(lblSub);
            this.Controls.Add(headerPanel);

            this.chkDesktop = new CheckBox();
            this.chkDesktop.Text = "ایجاد آیکون برنامه روی دسکتاپ (Desktop Shortcut)";
            this.chkDesktop.Checked = true;
            this.chkDesktop.AutoSize = true;
            this.chkDesktop.Location = new Point(24, 102);

            this.chkStartMenu = new CheckBox();
            this.chkStartMenu.Text = "افزودن به منوی استارت ویندوز (Start Menu)";
            this.chkStartMenu.Checked = true;
            this.chkStartMenu.AutoSize = true;
            this.chkStartMenu.Location = new Point(24, 130);

            this.chkLaunchAfter = new CheckBox();
            this.chkLaunchAfter.Text = "اجرای خودکار کافه وان پس از پایان نصب";
            this.chkLaunchAfter.Checked = true;
            this.chkLaunchAfter.AutoSize = true;
            this.chkLaunchAfter.Location = new Point(24, 158);

            this.lblStatus = new Label();
            this.lblStatus.Text = "آماده نصب. روی «شروع نصب» کلیک کنید.";
            this.lblStatus.AutoSize = false;
            this.lblStatus.Size = new Size(512, 22);
            this.lblStatus.Location = new Point(24, 192);
            this.lblStatus.ForeColor = Color.FromArgb(243, 198, 143);

            this.progressBar = new ProgressBar();
            this.progressBar.Location = new Point(24, 218);
            this.progressBar.Size = new Size(512, 22);
            this.progressBar.Minimum = 0;
            this.progressBar.Maximum = 100;

            this.txtLog = new TextBox();
            this.txtLog.Multiline = true;
            this.txtLog.ReadOnly = true;
            this.txtLog.ScrollBars = ScrollBars.Vertical;
            this.txtLog.RightToLeft = RightToLeft.No;
            this.txtLog.BackColor = Color.FromArgb(14, 10, 8);
            this.txtLog.ForeColor = Color.FromArgb(215, 220, 225);
            this.txtLog.Font = new Font("Consolas", 8.5F);
            this.txtLog.Location = new Point(24, 252);
            this.txtLog.Size = new Size(512, 128);

            this.btnInstall = new Button();
            this.btnInstall.Text = "شروع نصب";
            this.btnInstall.Size = new Size(140, 36);
            this.btnInstall.Location = new Point(24, 392);
            this.btnInstall.BackColor = Color.FromArgb(184, 118, 46);
            this.btnInstall.ForeColor = Color.White;
            this.btnInstall.FlatStyle = FlatStyle.Flat;
            this.btnInstall.FlatAppearance.BorderSize = 0;
            this.btnInstall.Font = new Font("Tahoma", 9.5F, FontStyle.Bold);
            this.btnInstall.Click += OnInstallClick;

            this.btnClose = new Button();
            this.btnClose.Text = "بستن";
            this.btnClose.Size = new Size(100, 36);
            this.btnClose.Location = new Point(176, 392);
            this.btnClose.BackColor = Color.FromArgb(56, 40, 32);
            this.btnClose.ForeColor = Color.White;
            this.btnClose.FlatStyle = FlatStyle.Flat;
            this.btnClose.FlatAppearance.BorderSize = 0;
            this.btnClose.Click += OnCloseClick;

            this.Controls.Add(this.chkDesktop);
            this.Controls.Add(this.chkStartMenu);
            this.Controls.Add(this.chkLaunchAfter);
            this.Controls.Add(this.lblStatus);
            this.Controls.Add(this.progressBar);
            this.Controls.Add(this.txtLog);
            this.Controls.Add(this.btnInstall);
            this.Controls.Add(this.btnClose);

            this.FormClosing += OnFormClosing;
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (this.isInstalling)
            {
                e.Cancel = true;
            }
        }

        private void OnCloseClick(object sender, EventArgs e)
        {
            if (!this.isInstalling)
            {
                this.Close();
            }
        }

        private void OnInstallClick(object sender, EventArgs e)
        {
            if (this.isInstalling) return;
            if (this.installSucceeded)
            {
                LaunchApp();
                this.Close();
                return;
            }

            this.isInstalling = true;
            this.btnInstall.Enabled = false;
            this.btnClose.Enabled = false;
            this.chkDesktop.Enabled = false;
            this.chkStartMenu.Enabled = false;
            this.chkLaunchAfter.Enabled = false;
            this.txtLog.Clear();

            bool mkDesktop = this.chkDesktop.Checked;
            bool mkStartMenu = this.chkStartMenu.Checked;
            bool launchAfter = this.chkLaunchAfter.Checked;

            Thread worker = new Thread(delegate () { RunInstall(mkDesktop, mkStartMenu, launchAfter); });
            worker.IsBackground = true;
            worker.Start();
        }

        private void RunInstall(bool mkDesktop, bool mkStartMenu, bool launchAfter)
        {
            try
            {
                UpdateProgress(10, "در حال بررسی فایل‌های برنامه...");
                string frontendIndex = Path.Combine(this.rootDir, "frontend", "out", "index.html");
                if (!File.Exists(frontendIndex))
                {
                    throw new Exception("پوشه بیلد رابط کاربری (frontend\\out\\index.html) یافت نشد. لطفاً بسته آماده Releases را دانلود یا ابتدا فرانت‌اند را بیلد کنید.");
                }

                string launcherExe = Path.Combine(this.rootDir, "CafeOne.exe");
                if (!File.Exists(launcherExe))
                {
                    throw new Exception("فایل اجرایی CafeOne.exe در پوشه برنامه وجود ندارد.");
                }

                UpdateProgress(20, "در حال بررسی پایتون و پیش‌نیازها...");
                string activePython = FindOrSetupPython();

                UpdateProgress(72, "در حال آماده‌سازی پایگاه‌داده SQLite...");
                string dbFile = Path.Combine(this.rootDir, "backend", "prisma", "database.sqlite");
                if (!File.Exists(dbFile))
                {
                    int pushCode = RunProcess(activePython, "-m prisma db push --schema=backend\\prisma\\schema.prisma");
                    if (pushCode != 0)
                    {
                        throw new Exception("ساخت پایگاه‌داده با خطا مواجه شد.");
                    }
                    AppendLog("[OK] Initialized backend\\prisma\\database.sqlite");
                }
                else
                {
                    AppendLog("[OK] Preserved existing backend\\prisma\\database.sqlite");
                }

                UpdateProgress(88, "در حال ساخت شورتکات‌های ویندوز...");
                string iconPath = Path.Combine(this.rootDir, "assets", "cafe-one.ico");
                if (mkDesktop)
                {
                    string desktopLnk = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                        "کافه وان (Cafe One).lnk"
                    );
                    CreateShortcut(desktopLnk, launcherExe, this.rootDir, iconPath);
                    AppendLog("[OK] Desktop shortcut created.");
                }
                if (mkStartMenu)
                {
                    string programsDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                    string startLnk = Path.Combine(programsDir, "کافه وان (Cafe One).lnk");
                    CreateShortcut(startLnk, launcherExe, this.rootDir, iconPath);
                    AppendLog("[OK] Start Menu shortcut created.");
                }

                UpdateProgress(100, "نصب کافه وان با موفقیت کامل شد!");
                AppendLog("[DONE] Cafe One installation completed.");

                this.BeginInvoke((MethodInvoker)delegate
                {
                    this.isInstalling = false;
                    this.installSucceeded = true;
                    this.btnClose.Enabled = true;
                    this.btnInstall.Enabled = true;
                    this.btnInstall.Text = "اجرای کافه وان";
                    if (launchAfter)
                    {
                        LaunchApp();
                        this.Close();
                    }
                });
            }
            catch (Exception ex)
            {
                AppendLog("[ERROR] " + ex.Message);
                this.BeginInvoke((MethodInvoker)delegate
                {
                    this.isInstalling = false;
                    this.btnClose.Enabled = true;
                    this.btnInstall.Enabled = true;
                    this.chkDesktop.Enabled = true;
                    this.chkStartMenu.Enabled = true;
                    this.chkLaunchAfter.Enabled = true;
                    this.lblStatus.Text = "نصب متوقف شد. جزئیات را در کادر زیر ببینید.";
                    this.lblStatus.ForeColor = Color.FromArgb(248, 113, 113);
                    MessageBox.Show(
                        ex.Message,
                        "خطا در نصب کافه وان",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error,
                        MessageBoxDefaultButton.Button1,
                        MessageBoxOptions.RightAlign | MessageBoxOptions.RtlReading
                    );
                });
            }
        }

        private string FindOrSetupPython()
        {
            string venvPython = Path.Combine(this.rootDir, ".venv", "Scripts", "python.exe");
            if (File.Exists(venvPython) && CheckPackages(venvPython))
            {
                AppendLog("[OK] Existing .venv environment is ready.");
                return venvPython;
            }

            string sysPython = ResolveSystemPython();
            if (!string.IsNullOrEmpty(sysPython) && CheckPackages(sysPython) && !Directory.Exists(Path.Combine(this.rootDir, ".venv")))
            {
                AppendLog("[OK] Using system Python with installed Cafe One dependencies.");
                return sysPython;
            }

            if (string.IsNullOrEmpty(sysPython))
            {
                throw new Exception("پایتون (Python 3.11+) روی سیستم نصب نیست. لطفاً ابتدا Python را با تیک Add Python to PATH نصب کرده و مجدداً تلاش کنید.");
            }

            if (!File.Exists(venvPython))
            {
                UpdateProgress(32, "در حال ساخت محیط ایزوله پایتون (.venv)...");
                int venvCode = RunProcess(sysPython, "-m venv .venv");
                if (venvCode != 0 || !File.Exists(venvPython))
                {
                    throw new Exception("ساخت پوشه .venv با خطا مواجه شد.");
                }
            }

            UpdateProgress(45, "در حال نصب پکیج‌ها (ممکن است ۱ تا ۳ دقیقه طول بکشد)...");
            RunProcess(venvPython, "-m pip install --upgrade pip");
            int pipCode = RunProcess(venvPython, "-m pip install -r requirements.txt");
            if (pipCode != 0)
            {
                throw new Exception("نصب وابستگی‌های requirements.txt ناموفق بود. اتصال اینترنت را بررسی کنید.");
            }

            UpdateProgress(65, "در حال تولید کلاینت پایگاه‌داده Prisma...");
            int genCode = RunProcess(venvPython, "-m prisma generate --schema=backend\\prisma\\schema.prisma");
            if (genCode != 0)
            {
                throw new Exception("اجرای prisma generate با خطا مواجه شد.");
            }

            return venvPython;
        }

        private string ResolveSystemPython()
        {
            string[] probes = new string[]
            {
                "python.exe|-c \"import sys; print(sys.executable)\"",
                "py.exe|-3 -c \"import sys; print(sys.executable)\""
            };
            foreach (string entry in probes)
            {
                string[] parts = entry.Split('|');
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo(parts[0], parts[1]);
                    psi.UseShellExecute = false;
                    psi.RedirectStandardOutput = true;
                    psi.CreateNoWindow = true;
                    using (Process p = Process.Start(psi))
                    {
                        string output = p.StandardOutput.ReadLine();
                        p.WaitForExit(8000);
                        if (p.ExitCode == 0 && !string.IsNullOrEmpty(output))
                        {
                            string candidate = output.Trim();
                            if (File.Exists(candidate)) return candidate;
                        }
                    }
                }
                catch { }
            }
            return null;
        }

        private bool CheckPackages(string pythonExe)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(pythonExe, "-c \"import fastapi, uvicorn, webview, prisma, PIL\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
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

        private int RunProcess(string fileName, string arguments)
        {
            AppendLog("> " + Path.GetFileName(fileName) + " " + arguments);
            ProcessStartInfo psi = new ProcessStartInfo(fileName, arguments);
            psi.WorkingDirectory = this.rootDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            using (Process proc = new Process())
            {
                proc.StartInfo = psi;
                proc.OutputDataReceived += delegate (object s, DataReceivedEventArgs ev)
                {
                    if (!string.IsNullOrEmpty(ev.Data)) AppendLog(ev.Data);
                };
                proc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs ev)
                {
                    if (!string.IsNullOrEmpty(ev.Data)) AppendLog(ev.Data);
                };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                proc.WaitForExit();
                return proc.ExitCode;
            }
        }

        private void CreateShortcut(string shortcutPath, string targetExe, string workDir, string iconPath)
        {
            string psScript =
                "$ws = New-Object -ComObject WScript.Shell; " +
                "$sc = $ws.CreateShortcut('" + shortcutPath.Replace("'", "''") + "'); " +
                "$sc.TargetPath = '" + targetExe.Replace("'", "''") + "'; " +
                "$sc.WorkingDirectory = '" + workDir.Replace("'", "''") + "'; " +
                "$sc.Description = 'Cafe One POS'; " +
                (File.Exists(iconPath) ? "$sc.IconLocation = '" + iconPath.Replace("'", "''") + "'; " : "") +
                "$sc.Save();";
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(psScript));
            int code = RunProcess("powershell.exe", "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded);
            if (code != 0)
            {
                throw new Exception("ساخت شورتکات ناموفق بود: " + shortcutPath);
            }
        }

        private void LaunchApp()
        {
            string exe = Path.Combine(this.rootDir, "CafeOne.exe");
            if (File.Exists(exe))
            {
                Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = this.rootDir });
            }
        }

        private void UpdateProgress(int value, string status)
        {
            this.BeginInvoke((MethodInvoker)delegate
            {
                this.progressBar.Value = Math.Max(0, Math.Min(100, value));
                this.lblStatus.Text = status;
            });
        }

        private void AppendLog(string line)
        {
            this.BeginInvoke((MethodInvoker)delegate
            {
                this.txtLog.AppendText(line + Environment.NewLine);
            });
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
