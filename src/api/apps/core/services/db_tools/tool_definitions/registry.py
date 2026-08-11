from .cms import DEFINITIONS as CMS
from .custom import DEFINITIONS as CUSTOM
from .events import DEFINITIONS as EVENTS
from .mail import DEFINITIONS as MAIL
from .members import DEFINITIONS as MEMBERS
from .projects import DEFINITIONS as PROJECTS

TOOL_DEFINITIONS = [*MEMBERS, *EVENTS, *PROJECTS, *MAIL, *CMS, *CUSTOM]
