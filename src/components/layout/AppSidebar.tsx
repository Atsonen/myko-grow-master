import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Boxes,
  Activity,
  FlaskConical,
  Database,
  Sprout,
  Thermometer,
  TrendingUp,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const main = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Strains", url: "/strains", icon: FlaskConical },
  { title: "Units", url: "/units", icon: Boxes },
  { title: "Environment", url: "/environment", icon: Thermometer },
  { title: "Trends", url: "/trends", icon: TrendingUp },
  { title: "Events", url: "/events", icon: Activity },
  { title: "Data", url: "/data", icon: Database },
];

const plants = [
  { title: "Plants", url: "/plants", icon: Sprout },
  { title: "Plant trends", url: "/plants/trends", icon: TrendingUp },
];

export function AppSidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (url: string) =>
    url === "/" || url === "/plants" ? path === url : path.startsWith(url);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded bg-primary/20 border border-primary/40 flex items-center justify-center text-primary font-mono text-xs">
            M
          </div>
          <div className="leading-tight">
            <div className="font-semibold text-sm tracking-wide">MYKO VALVOMO</div>
            <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
              Cultivation Control
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Myko</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {main.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)}>
                    <Link to={item.url} className="flex items-center gap-2">
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Plants</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {plants.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)}>
                    <Link to={item.url} className="flex items-center gap-2">
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
